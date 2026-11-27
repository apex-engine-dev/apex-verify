import { keptBehaviour } from "./kept.js";
import { outdatedTests } from "./outdated.js";
import { existsSync, promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { isJunkPath, testSandboxAvailable, testSandboxProfile, inTestSandbox, runEnv, checkCommand, frameworkCheckCommand, checksOnlyRunner, copyProject, parseTestOutcomes, runCommand, detectTestRunner, draftAcceptance, judgeFailingChecks, readTestOutput, runAcceptance, runTests, type ModelClient, type TestRunner } from "apex-verify-engine";
import { assertSafeDiff } from "./safe-diff.js";
import { looksSecret, redactingClient } from "./redact.js";
import { readRegularFile, stateDir, writePrivateFile } from "./state.js";
import { detectCheats, isTestFile, type Cheat, type FileChange } from "./cheats.js";

/**
 * apex verify: given a change somebody (usually an AI agent) already made, decide whether it is really done.
 *
 * ready      the tests still pass, nothing was weakened, and checks written from the task by an independent model fail on
 *            the old code and pass on the new.
 * not_ready  a proven problem: a test that used to pass now fails, a test was deleted or skipped, or a check written from
 *            the task fails on the new code.
 * unknown    not enough to say: no checks could be written, the checks cannot tell the old code from the new, or the
 *            failing checks look wrong. Never a silent pass.
 */
export type Verdict = "ready" | "not_ready" | "unknown";

/** The project's own type check, when it has one: the `typecheck` script, or `tsc --noEmit` with a tsconfig. A dangling import or a type error can leave every test green and still break the build. */
async function typecheckCommand(dir: string): Promise<{ file: string; args: string[]; label: string } | null> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    if (typeof pkg?.scripts?.typecheck === "string") return { file: "npm", args: ["run", "--silent", "typecheck"], label: "npm run typecheck" };
  } catch { /* no package.json */ }
  const tsc = path.join(dir, "node_modules", ".bin", "tsc");
  try { await fs.access(path.join(dir, "tsconfig.json")); await fs.access(tsc); return { file: tsc, args: ["--noEmit", "-p", "."], label: "tsc --noEmit" }; } catch { return null; }
}
/** The type check runs project-defined commands, so it gets what the tests get: the scrubbed environment (no keys or tokens) and the sandbox where there is one. */
async function typecheckRun(tc: { file: string; args: string[] }, dir: string, timeoutSec: number, signal?: AbortSignal) {
  let { file, args } = tc;
  if (await testSandboxAvailable().catch(() => false)) ({ file, args } = inTestSandbox(testSandboxProfile({ writable: [dir] }), file, args));
  return runCommand(file, args, { cwd: dir, timeoutMs: timeoutSec * 1000, signal, env: { ...runEnv(), CI: "1", FORCE_COLOR: "0" } }).catch(() => null);
}

export interface Reason { kind: "regression" | "cheat" | "check_failed" | "checks_flaky" | "checks_suspect" | "checkers_disagree" | "no_checks" | "checks_unproven" | "no_change" | "no_tests" | "tests_outdated"; summary: string; evidence?: string; hint?: string }

export interface VerifyReport {
  schema: 1;
  verdict: Verdict;
  reasons: Reason[];
  warnings: string[];
  task: string;
  change: { mode: "git" | "patch"; base: string; files: Array<{ path: string; status: "added" | "modified" | "deleted" }> };
  tests: { command: string | null; before: { passed: number; failed: number } | null; after: { passed: number; failed: number } | null; newlyFailing: string[] };
  /** The second checker's own result, when two checkers were used. */
  secondChecks?: { writtenBy: string | null; written: boolean; passed: number; failed: number; failedOnOldCode: boolean; failures: string; failedChecks: Array<{ name: string; expected?: string; actual?: string; message?: string }> };
  checks: { writtenBy: string | null; written: boolean; passed: number; failed: number; failedOnOldCode: boolean; failures: string; failedChecks: Array<{ name: string; expected?: string; actual?: string; message?: string }>; /** When the first set objected: how many independent sets were written and how many failed. */ agreement?: { sets: number; failing: number } };
  cheats: Cheat[];
  /** What isolated the tests and generated checks on this machine. */
  sandbox: string;
  usage: { modelCalls: number; seconds: number; /** Tokens the checker calls used (as reported by the provider; 0 when it reports none). */ inputTokens: number; outputTokens: number };
  proof: string;
  /** With --lock-tests: the project's own test files that the change edited or deleted, restored from the base before the tests ran. */
  lockedTests?: string[];
  /** With --sign-key: an Ed25519 signature over verdict, task and proof (see sign.ts). */
  signature?: { alg: "ed25519"; publicKey: string; value: string };
}

export interface VerifyOptions {
  /** Run the project's tests with the base versions of the test files the change edited or deleted (an agent cannot edit its way to green). New test files are kept. */
  lockTests?: boolean;
  dir: string;
  task: string;
  /** Compare the working copy with this git ref (default HEAD). */
  base?: string;
  /** Or: a unified diff to apply on a copy of `dir`. */
  diffFile?: string;
  /** The independent model that writes the checks. Without it only the deterministic parts run. */
  /** `cacheSecret` (the checker's API key) authenticates cached checks, so the cache may live where others can write (see readDraft). */
  checker?: { client: ModelClient; model: string; cacheSecret?: string } | null;
  /** A second, independent checker. A change is NOT READY only when both checkers object; if only one does the verdict is UNKNOWN (they disagree). */
  secondChecker?: { client: ModelClient; model: string; cacheSecret?: string } | null;
  /** Ask the checker to use inputs other than the task's own examples (default false). */
  freshInputs?: boolean;
  testCommand?: string[];
  timeoutSec?: number;
  /** How many times to try writing the checks when a try gives none. Default 2. */
  attempts?: number;
  /** Reuse checks written earlier for the same task and starting code (default true). */
  cache?: boolean;
  /** Ask the checker for unstated standard-practice cases too (CRLF, empty input, ...). Default false: measured, no gain (docs/EXPERIMENTS.md). */
  standardCases?: boolean;
  /** One short call decides whether failing checks or the change is at fault (default true). */
  secondLook?: boolean;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
}

const MAX_FILE = 1_000_000;

async function readTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    let ents: import("node:fs").Dirent[] = [];
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(dir, e.name);
      if (isJunkPath(path.relative(root, f).split(path.sep), true)) continue;
      if (e.isDirectory()) await walk(f);
      else if (e.isFile()) {
        try { const st = await fs.stat(f); if (st.size <= MAX_FILE) { const buf = await fs.readFile(f); if (!buf.includes(0)) out.set(path.relative(root, f).split(path.sep).join("/"), buf.toString("utf8")); } } catch { /* unreadable */ }
      }
    }
  }
  await walk(root);
  return out;
}

export interface Collected { orig: string; next: string; mode: "git" | "patch"; base: string; changes: FileChange[]; cleanup: () => Promise<void> }

const git = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

/** Two trees (before, after) in scratch folders; the project itself is never touched. */
export async function collectChange(o: { dir: string; base?: string; diffFile?: string }): Promise<Collected> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "apex-"));
  const origRoot = path.join(scratch, "before"); let orig = origRoot; const next = path.join(scratch, "after");
  const cleanup = () => fs.rm(scratch, { recursive: true, force: true });
  try {
    let mode: "git" | "patch" = "patch", base = "diff";
    if (o.diffFile) {
      await copyProject(o.dir, orig);
      await copyProject(o.dir, next);
      const diff = path.resolve(o.diffFile);
      assertSafeDiff(await fs.readFile(diff, "utf8"));
      let applied = false;
      // git apply only: it refuses paths that leave the folder and never writes through a symlink. The copy's link to the real node_modules is taken away while the diff is applied.
      const nm = path.join(next, "node_modules"); let nmTarget: string | null = null;
      try { if ((await fs.lstat(nm)).isSymbolicLink()) { nmTarget = await fs.readlink(nm); await fs.unlink(nm); } } catch { /* no link */ }
      try {
        for (const p of ["-p1", "-p0"]) {
          try { execFileSync("git", ["apply", p, "--whitespace=nowarn", diff], { cwd: next, stdio: "pipe", env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(next), GIT_DIR: path.join(scratch, "no-git") } }); applied = true; break; } catch { /* try the other strip level */ }
        }
      } finally { if (nmTarget) { try { await fs.symlink(nmTarget, nm, "dir"); } catch { /* a real folder is there now */ } } }
      if (!applied) throw new Error(`could not apply ${o.diffFile} to ${o.dir} (tried -p1 and -p0)`);
    } else {
      let inside = false;
      try { inside = git(o.dir, ["rev-parse", "--is-inside-work-tree"]).trim() === "true"; } catch { /* not a repo */ }
      if (!inside) throw new Error(`${o.dir} is not a git repository: run inside one, or pass --diff <file>`);
      base = o.base ?? "HEAD";
      try { git(o.dir, ["rev-parse", "--verify", `${base}^{commit}`]); } catch { throw new Error(`git ref not found: ${base}${o.base ? "" : " (a repository with no commits has nothing to compare with; pass --diff <file>)"}`); }
      const prefix = git(o.dir, ["rev-parse", "--show-prefix"]).trim();
      await fs.mkdir(origRoot, { recursive: true });
      // A directory that is new since the base (the whole folder is uncommitted) has nothing to compare with: its original is empty.
      const sub = prefix.replace(/\/$/, "");
      const existedAtBase = !sub || (() => { try { git(o.dir, ["cat-file", "-e", `${base}:${sub}`]); return true; } catch { return false; } })();
      orig = sub ? path.join(origRoot, ...sub.split("/")) : origRoot;
      await fs.mkdir(orig, { recursive: true });
      if (existedAtBase) {
        // The base as committed, through a temporary index: unlike `git archive` this ignores .gitattributes export-ignore, so a repository cannot hide its tests from the comparison.
        const top = git(o.dir, ["rev-parse", "--show-toplevel"]).trim();
        const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, "index") };
        execFileSync("git", ["-C", top, "read-tree", ...(sub ? [`--prefix=${sub}/`, `${base}:${sub}`] : [base])], { env, stdio: "pipe" });
        execFileSync("git", ["-C", top, "checkout-index", "-a", "-f", `--prefix=${origRoot.replace(/\\/g, "/")}/`], { env, stdio: "pipe", maxBuffer: 1024 * 1024 * 1024 });
      }
      // The same dependencies as the working copy gets (copyProject links them): without them the baseline test run cannot start.
      try { if (existsSync(path.join(o.dir, "node_modules")) && !existsSync(path.join(orig, "node_modules"))) await fs.symlink(path.join(o.dir, "node_modules"), path.join(orig, "node_modules"), "dir"); } catch { /* none */ }
      await copyProject(o.dir, next);
      mode = "git";
    }
    const [a, b] = await Promise.all([readTree(orig), readTree(next)]);
    const changes: FileChange[] = [];
    // Files git ignores (a .env, local config, caches) are in the working copy but are not part of the change, and must never be shown to a model as one.
    const ignored = new Set<string>();
    if (mode === "git") { try { for (const f of git(o.dir, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]).split("\0").filter(Boolean)) ignored.add(f.replace(/\\/g, "/")); } catch { /* none */ } }
    // Not part of the change either: files a sparse checkout left out (in the base, absent here on purpose) and submodules (their files are another repository's).
    const sparse = new Set<string>(); const submodules: string[] = [];
    if (mode === "git") {
      const pre = git(o.dir, ["rev-parse", "--show-prefix"]).trim();
      const rel = (f: string) => (pre && f.startsWith(pre) ? f.slice(pre.length) : f);
      try { for (const l of git(o.dir, ["ls-files", "-z", "-t", "--full-name"]).split("\0")) if (l.startsWith("S ")) sparse.add(rel(l.slice(2))); } catch { /* none */ }
      try { for (const l of git(o.dir, ["ls-files", "-z", "-s", "--full-name"]).split("\0")) { const m = /^160000 \S+ \d\t(.+)$/.exec(l); if (m) submodules.push(rel(m[1]!) + "/"); } } catch { /* none */ }
    }
    for (const p of new Set([...a.keys(), ...b.keys()])) {
      if (ignored.has(p) && !a.has(p)) continue;
      if ((sparse.has(p) && !b.has(p)) || submodules.some((d) => p.startsWith(d))) continue;
      const x = a.get(p) ?? null, y = b.get(p) ?? null;
      // A file that differs only in line endings is not a change (Windows checkouts with autocrlf are CRLF, git archive is LF).
      if (x !== y && (x === null || y === null || x.replace(/\r\n/g, "\n") !== y.replace(/\r\n/g, "\n"))) changes.push({ path: p, before: x, after: y });
    }
    changes.sort((m, n) => m.path.localeCompare(n.path));
    return { orig, next, mode, base, changes, cleanup };
  } catch (e) { await cleanup(); throw e; }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A cheap fingerprint of an installed node_modules (path, size and modification time of up to 60,000 entries; tool caches left out). */
export async function nodeModulesStamp(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const h = createHash("sha256"); let n = 0;
  async function walk(d: string): Promise<void> {
    let ents: import("node:fs").Dirent[] = [];
    try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (n >= 60_000) return;
      if (d === dir && [".cache", ".vite", ".vitest", ".vite-temp", ".package-lock.json"].includes(e.name)) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else { n++; try { const st = await fs.lstat(f); h.update(`${path.relative(dir, f)}:${st.size}:${st.mtimeMs}\n`); } catch { h.update(`${f}:?\n`); } }
    }
  }
  await walk(dir);
  return h.digest("hex");
}

/** A digest of every file in a folder (bytes, not only text), without following links: to notice code under test rewriting the baseline copy. */
export async function digestTree(root: string): Promise<string> {
  const h = createHash("sha256");
  async function walk(dir: string): Promise<void> {
    let ents: import("node:fs").Dirent[] = [];
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const f = path.join(dir, e.name), rel = path.relative(root, f);
      if (isJunkPath(rel.split(path.sep)) || e.name === ".apex-tmp") continue;
      if (e.isSymbolicLink()) { h.update(`L:${rel}\n`); continue; }
      if (e.isDirectory()) await walk(f);
      else if (e.isFile()) { h.update(`F:${rel}:`); try { h.update(await fs.readFile(f)); } catch { h.update("?"); } h.update("\n"); }
    }
  }
  await walk(root);
  return h.digest("hex");
}

type Draft = NonNullable<Awaited<ReturnType<typeof draftAcceptance>>>;
const cacheDir = () => path.join(process.env.APEX_CACHE_DIR || path.join(stateDir(), "cache"), "checks");
/** What a cached draft must look like; anything else (a forged or damaged file) is ignored. The command to run is never taken from the cache: it is derived again from the project. */
export function shapeOk(d: unknown): d is Draft {
  const x = d as any;
  if (!x || typeof x !== "object" || typeof x.code !== "string" || typeof x.path !== "string") return false;
  const p = x.path as string;
  if (p.length > 200 || path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).some((seg) => seg === ".." || seg === "") || !/^[\w.\-/]+$/.test(p)) return false;
  if (!/^(?:apex[-_]task[-_]check|test_apex_task_check)/.test(path.basename(p))) return false;
  const o = x.original;
  return !!o && typeof o.passed === "number" && typeof o.failed === "number" && (o.loadError === null || typeof o.loadError === "string");
}
/**
 * The same task on the same starting code with the same model gets the same checks: stable while an agent retries, and one model call, not one per attempt.
 * With a secret (the checker's API key), every entry carries a MAC and one without a valid MAC is ignored. That is what lets
 * the cache live somewhere other people can write, such as a CI cache that survives a re-run: a pull request from a fork has
 * no access to the key, so it cannot plant checks of its own.
 */
const draftMac = (secret: string, key: string, body: string) => createHmac("sha256", createHash("sha256").update("apex-verify-cache-v1\0" + secret).digest()).update(key + "\0" + body).digest("hex");
async function readDraft(key: string, testCommand: string[], secret?: string): Promise<Draft | null> {
  const text = readRegularFile(path.join(cacheDir(), key + ".json"));
  if (!text) return null;
  try {
    let d = JSON.parse(text) as any;
    if (d && typeof d.body === "string") {
      if (secret) { const want = Buffer.from(draftMac(secret, key, d.body)), got = Buffer.from(String(d.mac ?? "")); if (want.length !== got.length || !timingSafeEqual(want, got)) return null; }
      d = JSON.parse(d.body);
    } else if (secret) return null; // an entry without a MAC is not trusted once a secret is in use
    if (!shapeOk(d)) return null;
    const fw = (d as any).framework;
    if (fw !== undefined && !["vitest", "jest", "cargo", "go"].includes(fw)) return null;
    const cmd = fw ? { run: frameworkCheckCommand(fw, d.path), py: false } : checkCommand(testCommand, d.path);
    if (!cmd) return null;
    return { ...d, run: cmd.run, py: cmd.py } as Draft;
  } catch { return null; }
}
async function writeDraft(key: string, d: Draft, secret?: string): Promise<void> {
  const body = JSON.stringify(d);
  try { writePrivateFile(path.join(cacheDir(), key + ".json"), JSON.stringify(secret ? { body, mac: draftMac(secret, key, body) } : { body })); } catch { /* best effort */ }
}
const trim = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

export async function verify(o: VerifyOptions): Promise<VerifyReport> {
  // Whatever leaves the machine for a model is redacted first (keys, tokens, private keys), and secret-looking files are never offered to it.
  const tokens = { input: 0, output: 0 };
  const counting = (inner: ModelClient): ModelClient => ({ async *stream(req) {
    let i = 0, out = 0; // providers report running totals for a call: the last event is the call's usage
    try { for await (const e of inner.stream(req)) { if ((e as any).type === "usage") { i = Number((e as any).inputTokens) || i; out = Number((e as any).outputTokens) || out; } yield e; } }
    finally { tokens.input += i; tokens.output += out; }
  } });
  o = { ...o, ...(o.checker ? { checker: { ...o.checker, client: counting(redactingClient(o.checker.client)) } } : {}), ...(o.secondChecker ? { secondChecker: { ...o.secondChecker, client: counting(redactingClient(o.secondChecker.client)) } } : {}) };
  const t0 = Date.now();
  const say = (l: string) => o.onProgress?.(l);
  const timeout = o.timeoutSec ?? 90;
  const c = await collectChange({ dir: o.dir, base: o.base, diffFile: o.diffFile });
  try {
    const reasons: Reason[] = [], warnings: string[] = [];
    const files = c.changes.map((x) => ({ path: x.path, status: (x.before === null ? "added" : x.after === null ? "deleted" : "modified") as "added" | "modified" | "deleted" }));
    const report: VerifyReport = {
      schema: 1, verdict: "unknown", reasons, warnings, task: o.task,
      change: { mode: c.mode, base: c.base, files },
      tests: { command: null, before: null, after: null, newlyFailing: [] },
      checks: { writtenBy: o.checker?.model ?? null, written: false, passed: 0, failed: 0, failedOnOldCode: false, failures: "", failedChecks: [] },
      cheats: [], sandbox: (await testSandboxAvailable().catch(() => false)) ? (process.platform === "darwin" ? "macOS Seatbelt (best effort)" : process.platform === "linux" ? "Linux bubblewrap" : process.platform === "win32" ? "Windows AppContainer (no network, writes only in the scratch copy)" : "sandbox") : (process.platform === "win32" ? "none on Windows: API keys and tokens are removed from the environment, but files and network are not isolated (use WSL2 or a container for code you do not trust)" : "none (run in CI or a container for code you do not trust)"), usage: { modelCalls: 0, seconds: 0, inputTokens: 0, outputTokens: 0 }, proof: "",
    };
    const finish = (verdict: Verdict, checksCode = ""): VerifyReport => {
      report.verdict = verdict;
      report.usage.seconds = Math.round((Date.now() - t0) / 100) / 10;
      report.usage.inputTokens = tokens.input; report.usage.outputTokens = tokens.output;
      report.proof = "sha256:" + sha(JSON.stringify({ task: o.task, files: c.changes.map((x) => [x.path, x.before && sha(x.before), x.after && sha(x.after)]), checksCode, tests: report.tests, checks: report.checks, verdict }));
      return report;
    };

    if (!c.changes.length) {
      reasons.push({ kind: "no_change", summary: c.mode === "git" ? `nothing changed compared with ${c.base}` : "the diff changes nothing", hint: "Make the change first, then verify it." });
      return finish("unknown");
    }
    say(`change: ${files.length} file${files.length === 1 ? "" : "s"} (${files.map((f) => f.path).slice(0, 4).join(", ")}${files.length > 4 ? ", ..." : ""})`);

    // 0. locked tests: put the base's version of every edited or deleted test file back before anything runs
    const locked = new Set<string>();
    if (o.lockTests) {
      for (const x of c.changes) {
        if (x.before === null || !isTestFile(x.path)) continue;
        // Never write through a symlinked folder that leads out of the copy.
        const target = path.join(c.next, x.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const realNext = await fs.realpath(c.next), realDir = await fs.realpath(path.dirname(target));
        if (realDir !== realNext && !realDir.startsWith(realNext + path.sep)) continue;
        try { if ((await fs.lstat(target)).isSymbolicLink()) await fs.unlink(target); } catch { /* new file */ }
        await fs.writeFile(target, x.before);
        locked.add(x.path);
      }
      if (locked.size) { report.lockedTests = [...locked].sort(); say(`locked tests: restored ${locked.size} file${locked.size === 1 ? "" : "s"} from ${c.base}`); }
    }

    // 1. cheating: deterministic
    report.cheats = detectCheats(c.changes, o.task);
    for (const ch of report.cheats) {
      if (locked.has(ch.file)) warnings.push(`${ch.file}: ${ch.detail} (restored from ${c.base} by --lock-tests, so it does not count)`);
      else if (ch.severity === "high") reasons.push({ kind: "cheat", summary: `${ch.file}: ${ch.detail}`, hint: "Do not delete, skip or weaken tests to make a change pass. Restore them and fix the code instead." });
      else warnings.push(`${ch.file}: ${ch.detail}`);
    }

    // Without a sandbox the tests can write to the real node_modules (it is linked into the copies, not copied): notice when they did.
    const sandboxed = await testSandboxAvailable().catch(() => false);
    // APEX_REQUIRE_SANDBOX=1 (the GitHub Action sets it): never run the change's code, or checks a model wrote, without one.
    if (!sandboxed && process.env.APEX_REQUIRE_SANDBOX === "1") throw new Error("no test sandbox is available here and APEX_REQUIRE_SANDBOX=1 is set, so the change's code and the checks were not run (on Linux install bubblewrap and allow unprivileged user namespaces; see docs/SANDBOX.md)");
    const realNodeModules = path.join(o.dir, "node_modules");
    const nmBefore = sandboxed ? null : await nodeModulesStamp(realNodeModules);

    // The baseline copy must stay what it was: the new code's tests run first, in a sandbox that can write to the temp folder both copies live in.
    const baselineDigest = await digestTree(c.orig);
    let tampered = false;
    const baselineIntact = async () => {
      if (tampered) return false;
      if ((await digestTree(c.orig)) === baselineDigest) return true;
      tampered = true;
      reasons.push({ kind: "cheat", summary: "code in this change modified Apex verify's copy of the original project while it ran, so nothing can be compared against it", hint: "Tests and code under test must not write outside their own project folder." });
      return false;
    };

    // 2. the project's own tests, before and after
    const runner: TestRunner | null = await detectTestRunner(c.next, o.testCommand?.join(" ")).catch(() => null);
    if (runner) {
      report.tests.command = runner.command.join(" ");
      say(`tests: ${report.tests.command}`);
      const after = await runTests(c.next, runner.command, o.signal, Math.max(timeout, runner.timeoutSec ?? 0));
      const aOut = readTestOutput(after.output, after.exitCode !== 0);
      report.tests.after = { passed: after.passed, failed: after.failed };
      if (after.passed + after.failed === 0 && after.exitCode === 0) warnings.push(`the project's test command (${report.tests.command}) ran no tests, so only the checks written from the task say anything about this change`);
      // Tests failing, or no test ran at all: look at the original code too (a change whose test command now runs nothing is a regression when the original ran tests).
      if ((after.failed > 0 || (after.exitCode !== 0 && after.passed === 0) || after.passed + after.failed === 0) && (await baselineIntact())) {
        const before = await runTests(c.orig, runner.command, o.signal, Math.max(timeout, runner.timeoutSec ?? 0));
        const bOut = readTestOutput(before.output, before.exitCode !== 0);
        report.tests.before = { passed: before.passed, failed: before.failed };
        // Names of every failing test, nested ones too: a suite that failed before and fails now can hide a test that newly broke inside it.
        const failing = (out: string, top: string[]) => new Set([...top, ...parseTestOutcomes(out).filter((t) => !t.ok && !t.skipped).map((t) => t.name)]);
        const was = failing(before.output, bOut.failedNames);
        const fresh = [...failing(after.output, aOut.failedNames)].filter((n) => !was.has(n));
        report.tests.newlyFailing = fresh;
        const couldNotRun = after.passed + after.failed === 0 && before.passed + before.failed > 0;
        // The original code's tests did not run (nothing passed, something failed: a missing build or dependency): then there is no baseline to call a failure new.
        const baselineBroken = before.passed === 0 && before.failed > 0;
        if (baselineBroken && !couldNotRun) warnings.push(`the project's tests could not run on the original code (0 passed, ${before.failed} failed), so a regression cannot be told from a failure that was already there; run the tests on a clean checkout to check`);
        else if (fresh.length || after.failed > before.failed || couldNotRun) {
          reasons.push({
            kind: "regression",
            summary: couldNotRun ? "the project's tests no longer run" : `${fresh.length || after.failed - before.failed} test${(fresh.length || after.failed - before.failed) === 1 ? "" : "s"} that passed before now fail${fresh.length ? `: ${fresh.slice(0, 3).join(", ")}` : ""}`,
            evidence: trim(after.output.split("\n").filter((l) => /not ok|fail|error|assert/i.test(l)).slice(0, 12).join("\n"), 1500),
            hint: "The change broke behaviour that worked before. Fix the change; do not edit the tests.",
          });
          // A failing test may assert exactly the old behaviour the task asks to change: a second look, which must quote the task.
          if (o.checker && fresh.length && !couldNotRun && process.env.APEX_OUTDATED !== "0") {
            const reg = reasons[reasons.length - 1]!;
            const j = await outdatedTests({ client: o.checker.client, model: o.checker.model, task: o.task, origDir: c.orig, failingNames: fresh, failureOutput: reg.evidence ?? "", signal: o.signal }).catch(() => null);
            report.usage.modelCalls++;
            if (j?.outdated) reasons[reasons.length - 1] = { kind: "tests_outdated", summary: `${fresh.length} test${fresh.length === 1 ? "" : "s"} that passed before now fail${fresh.length === 1 ? "s" : ""}, but ${fresh.length === 1 ? "it asserts" : "they assert"} the old behaviour the task asks to change: ${fresh.slice(0, 3).join(", ")}`, evidence: trim(`task: "${j.quote}"
${j.why}

${reg.evidence ?? ""}`, 1500), hint: "If that is right, update the test to the new behaviour in the same change; until then the change is not proven ready." };
          }
        } else warnings.push(`${after.failed} test${after.failed === 1 ? "" : "s"} failed before the change too (not counted against it)`);
      }
    } else {
      // A test script that could not be used because the dependencies it needs are not installed: say so, it is the usual reason.
      let missingDeps = false;
      try { const pkg = JSON.parse(await fs.readFile(path.join(c.next, "package.json"), "utf8")); missingDeps = typeof pkg?.scripts?.test === "string" && Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0 && !existsSync(path.join(o.dir, "node_modules")); } catch { /* no package.json */ }
      warnings.push(missingDeps ? "dependencies are not installed (run npm install or your package manager's install), so the project's tests could not run; only the checks written from the task can prove anything" : "no test runner found: only the checks written from the task can prove anything (pass --test \"<command>\" to use your own)");
    }

    // 2a. a change that edits how the tests run (the test script, or the runner's settings) is judged by the ORIGINAL
    // test command too: every test that passed on the old code must still pass on the new code. Otherwise a change could
    // drop the one test it broke from the script or the config and pass with only a warning.
    const testsTouched = report.cheats.some((ch) => (ch.kind === "test_script_changed" || ch.kind === "test_config_changed") && !locked.has(ch.file));
    if (testsTouched && !reasons.some((r) => r.kind === "regression") && (await baselineIntact())) {
      const baseRunner: TestRunner | null = await detectTestRunner(c.orig, o.testCommand?.join(" ")).catch(() => null);
      if (baseRunner) {
        const t = Math.max(timeout, baseRunner.timeoutSec ?? 0);
        const before = await runTests(c.orig, baseRunner.command, o.signal, t);
        const afterBase = await runTests(c.next, baseRunner.command, o.signal, t);
        const passedNames = (out: string) => new Set(parseTestOutcomes(out).filter((x) => x.ok && !x.skipped).map((x) => x.name));
        const was = passedNames(before.output), now = passedNames(afterBase.output);
        const lost = [...was].filter((n) => !now.has(n));
        const ranAny = afterBase.passed + afterBase.failed > 0;
        if (lost.length && ranAny) reasons.push({
          kind: "regression",
          summary: `the change edits how the tests run, and with the original test command (${baseRunner.command.join(" ")}) ${lost.length} test${lost.length === 1 ? "" : "s"} that passed before ${lost.length === 1 ? "no longer passes" : "no longer pass"}: ${lost.slice(0, 3).join(", ")}`,
          evidence: trim(afterBase.output.split("\n").filter((l) => /not ok|fail|error|assert/i.test(l)).slice(0, 12).join("\n"), 1500),
          hint: "Do not change the test script or test settings to leave out a test the change broke. Fix the code, or explain in the task why the test should go.",
        });
        else if (lost.length) warnings.push(`the change edits how the tests run, and the original test command (${baseRunner.command.join(" ")}) no longer runs on the new code, so tests that passed before cannot be checked; review the test command change by hand`);
      }
    }

    // 2b. the project's type check, if it has one: only errors the change introduced count
    const tc = await typecheckCommand(c.next);
    if (tc) {
      const after = await typecheckRun(tc, c.next, timeout, o.signal);
      if (!after || after.timedOut) warnings.push(`${tc.label} did not finish${after?.timedOut ? ` within ${timeout}s` : ""}, so type errors were not checked`);
      else if (after.exitCode !== 0 && (await baselineIntact())) {
        const before = await typecheckRun(tc, c.orig, timeout, o.signal);
        const lines = (r: { stdout: string; stderr: string }) => (r.stdout + r.stderr).split("\n").filter((l) => /error|TS\d{3,}/i.test(l));
        const was = new Set(before ? lines(before).map((l) => l.replace(/\(\d+,\d+\)|:\d+:\d+/g, "")) : []);
        const fresh = lines(after).filter((l) => !was.has(l.replace(/\(\d+,\d+\)|:\d+:\d+/g, "")));
        // It passed on the original code and fails now: a regression, whatever words the tool printed.
        const passedBefore = !!before && !before.timedOut && before.exitCode === 0;
        if (fresh.length || passedBefore) reasons.push({ kind: "regression", summary: fresh.length ? `${tc.label} reports ${fresh.length} new error${fresh.length === 1 ? "" : "s"} the change introduced` : `${tc.label} passed before the change and fails now`, evidence: trim((fresh.length ? fresh.slice(0, 8).join("\n") : (after.stdout + after.stderr)), 1500), hint: "Fix the type or import errors; they would break the build even though the tests pass." });
      }
    }

    // 3. independent checks written from the task, proven on the old code, run on the new (once per checker)
    type Checker = { client: ModelClient; model: string; cacheSecret?: string };
    type ChecksRec = VerifyReport["checks"];
    // variant 1 is an independent second draft (experiment APEX_EXP_DRAFTS=2): other inputs than the first, its own cache entry.
    const checkWith = async (ck: Checker, T: ChecksRec, push: (r: Reason) => void, variant = 0): Promise<string> => {
      const fresh = (o.freshInputs === true) !== (variant === 1);
      let code = "";
      const cr: TestRunner | null = runner ?? (await checksOnlyRunner(c.next).catch(() => null));
      if (!cr) warnings.push("the project has no language Apex verify can write checks for (node:test and pytest are supported)");
      else {
        say(`checks: ${ck.model} writes them from the task (never from the agent's own tests)`);
        let draft: Awaited<ReturnType<typeof draftAcceptance>> = null;
        // The engine turns a failed model call into "no answer"; keep the checker's own error so the report can say why.
        let checkerError = "";
        const seen: ModelClient = { async *stream(req) { for await (const ev of ck.client.stream(req)) { if (ev.type === "error") checkerError = ev.message; yield ev; } } };
        const key = sha(JSON.stringify([o.task, ck.model, o.standardCases === true, fresh, ...(variant ? [variant] : []), [...(await readTree(c.orig)).entries()].map(([p, t]) => [p, sha(t)])]));
        if (o.cache !== false) { draft = await readDraft(key, cr.command, ck.cacheSecret); if (draft) say("checks: reused from an earlier run on the same task and code"); }
        for (let i = 0; i < (o.attempts ?? 2) && !draft; i++) {
          draft = await draftAcceptance({ hidden: looksSecret, gateway: seen, model: ck.model, root: c.orig, task: o.task, testCommand: cr.command, timeoutSec: timeout, signal: o.signal, standardCases: o.standardCases === true, freshInputs: fresh }).catch(() => null);
          report.usage.modelCalls += draft?.calls ?? 1;
          if (draft && o.cache !== false) await writeDraft(key, draft, ck.cacheSecret);
        }
        if (!draft) warnings.push(checkerError ? `the checker failed: ${checkerError.split("\n")[0]!.slice(0, 240)}` : "no usable checks could be written for this task");
        else {
          T.written = true;
          code = draft.code;
          T.failedOnOldCode = draft.original.failed > 0 || !!draft.original.loadError;
          const spec = { path: draft.path, code: draft.code, run: draft.run, py: draft.py, ...(draft.framework ? { framework: draft.framework } : {}) };
          let run = await runAcceptance(c.next, spec, o.signal, timeout);
          // A check that fails once and passes on a rerun is flaky: not evidence that the change is wrong, and not that it is
          // right either (a change that is wrong only some of the time looks exactly like this). Never READY on it: UNKNOWN.
          let flaky = 0;
          if (run.failed > 0 && process.env.APEX_RERUN !== "0") {
            const again = await runAcceptance(c.next, spec, o.signal, timeout);
            if (again.failed === 0 && !again.loadError && again.passed >= run.passed + run.failed) { flaky = run.failed; run = again; }
          }
          T.passed = run.passed;
          T.failed = run.failed + (run.loadError && run.passed + run.failed === 0 ? 1 : 0);
          T.failedChecks = parseTestOutcomes(run.output ?? "").filter((x) => !x.ok && !x.skipped && x.top !== false).slice(0, 8).map((x) => ({ name: x.name.replace(/^\[c\d+\]\s*/, "").replace(/^task:\s*/i, ""), ...(x.failure?.expected ? { expected: trim(String(x.failure.expected), 160) } : {}), ...(x.failure?.actual !== undefined ? { actual: trim(String(x.failure.actual), 160) } : {}), ...(x.failure?.message && !x.failure.expected ? { message: trim(x.failure.message.split("\n").find((l) => l.trim()) ?? "", 200) } : {}) }));
          T.failures = T.failedChecks.length
            ? T.failedChecks.map((x) => `check: ${x.name}${x.expected !== undefined ? `\n  expected: ${x.expected}\n  actual:   ${x.actual ?? "?"}` : `${x.message ? `\n  ${x.message}` : ""}${x.actual !== undefined ? `\n  actual:   ${x.actual}` : ""}`}`).join("\n")
            : trim(run.failures || (run.loadError ?? ""), 2000);
          say(`checks: ${run.passed} passed, ${T.failed} failed (${T.failedOnOldCode ? "they fail on the old code, so they can tell the difference" : "they also pass on the old code"})`);
          if (T.failed > 0) {
            let blame: "test" | "code" | "unknown" = "unknown", why = "";
            if (o.secondLook !== false) {
              const j = await judgeFailingChecks({ gateway: ck.client, model: ck.model, task: o.task, changes: c.changes.filter((x) => !looksSecret(x.path)).map((x) => ({ path: x.path, before: x.before, after: x.after ?? "" })), checksFile: draft.code, failureOutput: T.failures, passed: run.passed, failed: T.failed, signal: o.signal }).catch(() => null);
              if (j) { blame = j.verdict; why = j.reason; report.usage.modelCalls++; }
            }
            if (blame === "test") push({ kind: "checks_suspect", summary: "a check written from the task fails, but on a second look the check itself looks wrong", evidence: trim(`${why}\n${T.failures}`, 1800), hint: "Review the failing check: it may over-reach. If the change is right, this is a false alarm." });
            else push({ kind: "check_failed", summary: `${T.failed} check${T.failed === 1 ? "" : "s"} written from the task ${T.failed === 1 ? "fails" : "fail"} on the new code`, evidence: trim(T.failures, 1800), hint: "Make the change satisfy the behaviour in the task; the failing check output shows what is expected." });
          } else if (flaky) {
            push({ kind: "checks_flaky", summary: `${flaky} check${flaky === 1 ? "" : "s"} written from the task failed on the new code once and passed on a rerun`, hint: "Either the check or the change is not deterministic. A change that is right only some of the time also looks like this, so review it by hand, or run verify again." });
          } else if (!T.failedOnOldCode) {
            push({ kind: "checks_unproven", summary: "the checks pass, but they also pass on the old code, so they cannot show the change did anything", hint: "Describe the behaviour that should differ, or review the change by hand." });
          }
        }
      }
      return code;
    };
    const blank = (m: string | null): ChecksRec => ({ writtenBy: m, written: false, passed: 0, failed: 0, failedOnOldCode: false, failures: "", failedChecks: [] });
    const firstReasons: Reason[] = [], secondReasons: Reason[] = [];
    let checksCode = "";
    if (o.checker) checksCode = await checkWith(o.checker, report.checks, (r) => firstReasons.push(r));
    // Experiment (APEX_EXP_DRAFTS=2): when the first set of checks finds nothing, write a second, independent set and
    // block if either finds a problem. Costs one more draft only on changes the first set passed.
    if (o.checker && !o.secondChecker && process.env.APEX_EXP_DRAFTS === "2" && report.checks.written && !firstReasons.some((r) => r.kind === "check_failed")) {
      const T2 = blank(o.checker.model), r2: Reason[] = [];
      const code2 = await checkWith(o.checker, T2, (r) => r2.push(r), 1);
      if (T2.written && r2.some((r) => r.kind === "check_failed")) {
        Object.assign(report.checks, T2); firstReasons.length = 0; firstReasons.push(...r2); checksCode = code2;
        warnings.push("the first set of checks passed; a second, independent set written from the task found this");
      }
    }
    // Agreement before blocking (opt-in, APEX_VOTE=1; on the benchmark it saved 1 false alarm in 93 at two drafts per blocked change): when the checks find a problem, two more
    // independent sets are written from the task and the change is blocked only when most of the sets that could be
    // written fail on it. One over-reaching draft then no longer blocks a right change. Costs two drafts, only on changes
    // the first set objects to; changes it passes are untouched, so this can only lower false alarms, never add one.
    if (o.checker && !o.secondChecker && process.env.APEX_VOTE === "1" && process.env.APEX_EXP_DRAFTS !== "2" && report.checks.written && firstReasons.some((r) => r.kind === "check_failed")) {
      let sets = 1, failing = 1;
      for (const v of [1, 2]) {
        const Tv = blank(o.checker.model), rv: Reason[] = [];
        await checkWith(o.checker, Tv, (r) => rv.push(r), v);
        if (!Tv.written) continue;
        sets++;
        if (rv.some((r) => r.kind === "check_failed")) failing++;
      }
      report.checks.agreement = { sets, failing };
      if (sets >= 2 && failing * 2 <= sets) {
        const i = firstReasons.findIndex((r) => r.kind === "check_failed");
        const f = firstReasons[i]!;
        firstReasons[i] = { kind: "checks_suspect", summary: `only ${failing} of ${sets} independent sets of checks written from the task find a problem, so the failing check may over-reach`, evidence: f.evidence, hint: "Review the failing check by hand: most independent checks pass on this change. If the change is right, this is a false alarm." };
      } else if (sets >= 2) warnings.push(`${failing} of ${sets} independent sets of checks written from the task find a problem`);
    }
    // Experiment (APEX_EXP_KEEP=1): did the change keep the behaviour the task did not ask to change?
    if (o.checker && process.env.APEX_EXP_KEEP === "1") {
      const kept = await keptBehaviour({ client: o.checker.client, model: o.checker.model, task: o.task, oldDir: c.orig, newDir: c.next, changes: c.changes, signal: o.signal, timeoutSec: timeout }).catch((e) => { warnings.push(`kept-behaviour probe failed: ${String(e?.message ?? e).slice(0, 200)}`); return null; });
      if (kept) { report.usage.modelCalls += kept.calls; if (kept.reason) firstReasons.push(kept.reason); }
    }
    if (o.checker && o.secondChecker) {
      report.secondChecks = blank(o.secondChecker.model);
      await checkWith(o.secondChecker, report.secondChecks, (r) => secondReasons.push(r));
    }
    const objects = (rs: Reason[]) => rs.some((r) => r.kind === "check_failed");
    const second = report.secondChecks;
    if (second && report.checks.written && second.written) {
      const a1 = objects(firstReasons), a2 = objects(secondReasons);
      if (a1 && a2) {
        const f = firstReasons.find((r) => r.kind === "check_failed")!, g = secondReasons.find((r) => r.kind === "check_failed")!;
        reasons.push({ kind: "check_failed", summary: `both checkers found a problem: ${f.summary} (${report.checks.writtenBy}); ${g.summary} (${second.writtenBy})`, evidence: trim(`${report.checks.writtenBy}:\n${f.evidence ?? ""}\n\n${second.writtenBy}:\n${g.evidence ?? ""}`, 1900), hint: f.hint });
      } else if (a1 !== a2) {
        const objector = a1 ? report.checks.writtenBy : second.writtenBy, other = a1 ? second.writtenBy : report.checks.writtenBy;
        const r = (a1 ? firstReasons : secondReasons).find((x) => x.kind === "check_failed")!;
        reasons.push({ kind: "checkers_disagree", summary: `the two checkers disagree: ${objector} found a problem, ${other} found none`, evidence: r.evidence, hint: "Review the objection by hand: with two checkers a single objection is not enough to block the change, and not enough to call it ready." });
      } else reasons.push(...firstReasons.filter((r) => r.kind !== "check_failed"), ...secondReasons.filter((r) => r.kind === "checks_unproven" && !firstReasons.some((x) => x.kind === "checks_unproven")));
    } else {
      if (second && !second.written) warnings.push(`the second checker (${second.writtenBy}) could not write usable checks, so only ${report.checks.writtenBy} judged the change`);
      else if (second && !report.checks.written) { Object.assign(report.checks, second); report.secondChecks = undefined; warnings.push("only the second checker could write usable checks"); }
      reasons.push(...(report.checks.written || !second ? firstReasons : secondReasons));
    }

    if (nmBefore !== null && (await nodeModulesStamp(realNodeModules)) !== nmBefore) {
      reasons.push({ kind: "cheat", summary: "code in this change modified the project's installed dependencies (node_modules) while its tests ran; there was no sandbox to stop it", hint: "Reinstall your dependencies (for example `npm ci`) before trusting this checkout, and run Apex verify where a sandbox is available." });
    }

    // 4. the verdict
    const blocking = reasons.some((r) => r.kind === "cheat" || r.kind === "regression" || r.kind === "check_failed");
    if (blocking) return finish("not_ready", checksCode);
    if (report.checks.written && !reasons.length) return finish("ready", checksCode);
    if (!report.checks.written && !o.checker) reasons.push({ kind: "no_checks", summary: "no independent checks were written (no checker model given): only the project's tests and the cheating scan ran", hint: "Set GEMINI_API_KEY (or --provider / --model with that provider's key) and drop --no-model, so an independent model writes checks from the task." });
    else if (!report.checks.written) reasons.push({ kind: "no_checks", summary: "no usable checks could be written, so the change is not independently checked" });
    if (runner && !report.tests.after) reasons.push({ kind: "no_tests", summary: "the tests did not run" });
    return finish("unknown", checksCode);
  } finally { await c.cleanup(); }
}
