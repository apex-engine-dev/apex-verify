import { execFile, spawn, spawnSync } from "node:child_process";
import { inWindowsSandbox, winSandboxSpec, WIN_PREFIX } from "./sandbox-windows.js";
import { constants as fsConstants, existsSync, mkdirSync, promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The project's own tests: which command runs them, and how to read its result. The 3-versions path picks a
 * version by these, so a project is only as well served as its test runner is understood: node:test, anything
 * behind `npm test` (jest, vitest, mocha…), and pytest.
 */

export interface TestRunner {
  kind: "node" | "npm" | "pytest" | "go" | "cargo" | "make" | "custom";
  command: string[];
  /** Seconds one run may take before it counts as failed. */
  timeoutSec: number;
}

const SKIP = new Set(["node_modules", ".git", ".apex", ".venv", "venv", "dist", "build", ".next", "coverage", "__pycache__", "target"]);

async function findFile(root: string, test: (name: string, full: string) => Promise<boolean> | boolean, depth = 3, dir = root): Promise<boolean> {
  let entries: import("node:fs").Dirent[] = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isFile() && (await test(e.name, full))) return true;
    if (e.isDirectory() && depth > 0 && (await findFile(root, test, depth - 1, full))) return true;
  }
  return false;
}

const ran = new Set<string>();
/**
 * Whether a command runs cleanly. Only a success is remembered: a failure may be a slow first start or a tool that
 * is installed a minute later, and remembering it would hide the project's tests until the app restarts.
 */
async function canRun(cmd: string, args: string[]): Promise<boolean> {
  const key = [cmd, ...args].join(" ");
  if (ran.has(key)) return true;
  const ok = await new Promise<boolean>((resolve) => execFile(cmd, args, { timeout: 15_000 }, (err) => resolve(!err)));
  if (ok) ran.add(key);
  return ok;
}

/**
 * How Apex runs one test file it wrote (acceptance checks, a reproduction) for a project's test command: pytest
 * with the project's own interpreter, or node:test. Null when the command is neither (go, cargo, make, a custom
 * script): Apex writes no checks there. The one definition, for the versions step and the proof gate.
 * `native` says the project's own tests run with that same runner (node:test or pytest), so its test files can be
 * run one by one this way too; false for jest, vitest or mocha behind `npm test`.
 */
export function checkCommand(testCommand: string[], file: string): { run: string[]; py: boolean; native: boolean } | null {
  const joined = testCommand.join(" ");
  if (/\bpytest\b/.test(joined)) {
    const i = testCommand.findIndex((t) => /(^|\/)pytest$/.test(t));
    const head = i === 0 ? [testCommand[0]] : testCommand.includes("-m") ? testCommand.slice(0, testCommand.indexOf("-m") + 2) : ["python3", "-m", "pytest"];
    return { run: [...head, "-q", "-rA", "--no-header", "-p", "no:cacheprovider", file], py: true, native: true };
  }
  if (/(^|\/)(node|npm|npx|pnpm|yarn|vitest|jest)\b/.test(joined) || testCommand[0] === "node") return { run: ["node", "--test", file], py: false, native: testCommand[0] === "node" };
  return null;
}

export type Framework = "vitest" | "jest" | "cargo" | "go";
/** The project's own JavaScript test framework when it is Vitest or Jest (from package.json), else null: node:test and pytest need no help. */
export async function detectFramework(root: string): Promise<Framework | null> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const script = String(pkg.scripts?.test ?? "");
    if (deps.vitest || /\bvitest\b/.test(script)) return "vitest";
    if (deps.jest || /\bjest\b/.test(script)) return "jest";
  } catch { /* no package.json */ }
  if (await fs.access(path.join(root, "Cargo.toml")).then(() => true, () => false)) return "cargo";
  if (await fs.access(path.join(root, "go.mod")).then(() => true, () => false)) return "go";
  return null;
}
/** The Rust crate's name (for `use <name>::...` in an integration test), from Cargo.toml. */
export async function cargoCrateName(root: string): Promise<string> {
  try { const m = /^[ \t]*name\s*=\s*"([^"]+)"/m.exec(await fs.readFile(path.join(root, "Cargo.toml"), "utf8")); if (m) return m[1]!.replace(/-/g, "_"); } catch { /* none */ }
  return "crate_name";
}
/** Where a Go check file goes: the folder holding most of the non-test .go files (the root when it has any), and that package's name. */
export function goPackageOf(files: string[], read: (rel: string) => string): { dir: string; pkg: string } {
  const counts = new Map<string, string[]>();
  for (const f of files) if (/\.go$/.test(f) && !/_test\.go$/.test(f) && !/(^|\/)(vendor|testdata)\//.test(f)) { const d = path.posix.dirname(f); counts.set(d === "." ? "" : d, [...(counts.get(d === "." ? "" : d) ?? []), f]); }
  const best = counts.has("") ? "" : [...counts.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0] ?? "";
  const first = counts.get(best)?.[0];
  let pkg = "main";
  if (first) { try { pkg = /^[ \t]*package\s+(\w+)/m.exec(read(first))?.[1] ?? "main"; } catch { /* unreadable */ } }
  return { dir: best, pkg };
}
/** go test -v output as TAP, so check results are read the same way for every runner. Subtests are reported by their full name; a parent that only failed because a subtest did is left out. The t.Errorf lines stream right after "=== RUN   name". */
export function goToTap(output: string): string {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const msgs = new Map<string, string[]>();
  let cur = "";
  for (const l of plain) {
    const run = /^=== (?:RUN|CONT)\s+(\S+)/.exec(l);
    if (run) { cur = run[1]!; continue; }
    if (/^[ \t]*--- /.test(l) || /^(FAIL|ok|PASS)\b/.test(l)) { cur = ""; continue; }
    if (cur && /^\s+\S/.test(l)) msgs.set(cur, [...(msgs.get(cur) ?? []), l.trim()]);
  }
  const results = [...plain.join("\n").matchAll(/^[ \t]*--- (PASS|FAIL): (\S+)/gm)].map((m) => ({ ok: m[1] === "PASS", name: m[2]! }));
  const lines: string[] = []; let n = 0;
  for (const r of results) {
    if (!r.ok && results.some((o) => !o.ok && o.name.startsWith(r.name + "/"))) continue;
    n++;
    if (r.ok) { lines.push(`ok ${n} - ${r.name}`); continue; }
    const body = msgs.get(r.name) ?? [];
    const text = body.join(" ");
    const m = /(?:^|\s)\S+\.go:\d+:\s*(.*)$/.exec(body[0] ?? "");
    const detail = (m?.[1] ?? body[0] ?? "failed").trim();
    const g = /(?:got|actual)\W{0,3}\s*(.+?)[,;]?\s+(?:want|expected)\W{0,3}\s*(.+)$/i.exec(text) ?? /=\s*(.+?),\s*want\s+(.+)$/.exec(text);
    lines.push(`not ok ${n} - ${r.name}`, "  ---", `  error: ${detail}`, ...(g ? [`  actual: ${g[1]!.trim()}`, `  expected: ${g[2]!.trim()}`] : []), "  ...");
  }
  return lines.length ? `${output}\n${lines.join("\n")}\n` : output;
}
/** Whether a JavaScript project's source is TypeScript (a tsconfig, or .ts files under src), which plain node cannot import. */
export async function usesTypeScript(root: string): Promise<boolean> {
  if (await fs.access(path.join(root, "tsconfig.json")).then(() => true, () => false)) return true;
  return findFile(root, (n) => /\.tsx?$/.test(n) && !/\.d\.ts$/.test(n), 2);
}
/** How one check file runs under the project's own framework (the local binary: nothing is downloaded). */
export function frameworkCheckCommand(fw: Framework, file: string): string[] {
  if (fw === "go") { const d = path.posix.dirname(file); return ["go", "test", "-count=1", "-v", d === "." ? "." : "./" + d]; }
  if (fw === "cargo") return ["cargo", "test", "--test", path.posix.basename(file).replace(/\.rs$/, "")];
  return fw === "vitest" ? ["npx", "--no-install", "vitest", "run", "--reporter=tap-flat", file] : ["npx", "--no-install", "jest", "--verbose", "--runTestsByPath", file];
}
/** libtest ("test name ... FAILED", panic text with left/right) as TAP lines, so check results are read the same way for every runner. */
export function cargoToTap(output: string): string {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  const lines: string[] = []; let n = 0;
  for (const m of plain.matchAll(/^test (\S+) \.\.\. (ok|FAILED)[ \t]*$/gm)) {
    n++; const name = m[1]!;
    if (m[2] === "ok") { lines.push(`ok ${n} - ${name}`); continue; }
    const block = plain.split(`---- ${name} stdout ----`)[1]?.split(/^---- |^failures:/m)[0] ?? "";
    const left = /^[ \t]*left:\s*(.+)$/m.exec(block)?.[1]?.trim(), right = /^[ \t]*right:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const msg = block.split("\n").map((l) => l.trim()).find((l) => l && !/^thread '/.test(l)) ?? "failed";
    lines.push(`not ok ${n} - ${name}`, "  ---", `  error: ${msg}`, ...(left !== undefined ? [`  actual: ${left}`] : []), ...(right !== undefined ? [`  expected: ${right}`] : []), "  ...");
  }
  return lines.length ? `${output}\n${lines.join("\n")}\n` : output;
}
/** Jest prints no TAP; add TAP lines (name, expected, actual) so check results are read the same way for every runner. */
export function jestToTap(output: string): string {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  if (!/^[ \t]*Tests:\s/m.test(plain) || !/^[ \t]*[✓✕√×]\s/m.test(plain)) return output;
  const lines: string[] = []; let n = 0;
  const detail = new Map<string, { expected?: string; actual?: string; message?: string }>();
  for (const block of plain.split(/^[ \t]*●\s+/m).slice(1)) {
    const title = block.split("\n")[0]!.trim().split(/\s+›\s+/).pop()!.trim();
    const exp = /Expected[^:\n]*:\s*(.+)/.exec(block)?.[1]?.trim(), act = /Received[^:\n]*:\s*(.+)/.exec(block)?.[1]?.trim();
    const msg = block.split("\n").map((l) => l.trim()).find((l, i) => i > 0 && l && !/^expect\(/.test(l));
    detail.set(title, { expected: exp, actual: act, message: msg });
  }
  for (const m of plain.matchAll(/^[ \t]*([✓✕√×])\s+(.+?)(?:\s+\(\d+\s*ms\))?[ \t]*$/gm)) {
    n++; const ok = m[1] === "✓" || m[1] === "√", name = m[2]!.trim();
    lines.push(`${ok ? "ok" : "not ok"} ${n} - ${name}`);
    if (!ok) { const d = detail.get(name); lines.push("  ---", `  error: ${d?.message ?? "failed"}`, ...(d?.expected ? [`  expected: ${d.expected}`] : []), ...(d?.actual ? [`  actual: ${d.actual}`] : []), "  ..."); }
  }
  return `${output}\n${lines.join("\n")}\n`;
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);

/** The first executable called `name` on PATH, as a full path (not resolved through symlinks: a venv's python must stay the venv's). */
export async function whichOnPath(name: string, envPath = process.env.PATH ?? ""): Promise<string | null> {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (await fs.access(p, fsConstants.X_OK).then(() => true, () => false)) return p;
  }
  return null;
}

/** The command that runs this project's tests, or null when there are none Apex can run. */
/** `npm test`, or the project's own package manager when its lockfile says so and the tool is installed. */
async function packageManagerTest(root: string): Promise<string[]> {
  const has = (f: string) => exists(path.join(root, f));
  const onPath = async (bin: string) => (await runCommand(bin, ["--version"], { cwd: root, timeoutMs: 15_000 }).catch(() => null))?.exitCode === 0;
  if ((await has("pnpm-lock.yaml")) && (await onPath("pnpm"))) return ["pnpm", "--silent", "test"];
  if ((await has("yarn.lock")) && (await onPath("yarn"))) return ["yarn", "--silent", "test"];
  if (((await has("bun.lockb")) || (await has("bun.lock"))) && (await onPath("bun"))) return ["bun", "run", "test"];
  return ["npm", "test", "--silent"];
}

export async function detectTestRunner(root: string, override?: string): Promise<TestRunner | null> {
  // The project's own test command (passed in, for example `--test`) wins over detection.
  // An override that is just the project's usual test command (`npm test` on a node:test project, `go test ./...`…)
  // uses the detected runner: the versions path reads results by runner kind, and a generic `bash -c` hid them
  // (measured: every version scored "0 passing, 0 failing", so nothing was ever applied).
  if (override && override.trim()) {
    const cmd = override.trim().replace(/\s+/g, " ");
    const auto = await detectTestRunner(root).catch(() => null);
    if (auto && (cmd === auto.command.join(" ") || /^(npm|pnpm|yarn)( run)? test( --silent)?$/.test(cmd) || cmd === "node --test")) return auto;
    return { kind: "custom", command: ["bash", "-c", override.trim()], timeoutSec: 180 };
  }
  // A package.json test script that is a real one, with its dependencies installed.
  let script = "", declaresDeps = true;
  try { const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")); script = String(pkg.scripts?.test ?? ""); declaresDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0; } catch { /* none */ }
  const real = script && !/no test specified/i.test(script);
  const plainNode = /^[ \t]*node\s+--test\b/.test(script);
  // A plain `node --test [args]` script is run as written (it needs no node_modules): Node's own default patterns find
  // test/**/*.js, *-test.js and the like, which the *.test.js search below would miss. Shell syntax goes the npm way.
  if (plainNode && !/[;&|<>`$()'"\\]/.test(script)) return { kind: "node", command: script.trim().split(/\s+/), timeoutSec: 90 };
  // Dependencies must be installed for the script to mean anything; a script that runs node itself in a project that declares none (a zero-dependency library) needs no node_modules.
  if (real && ((!declaresDeps && /^[ \t]*node\b/.test(script)) || (await exists(path.join(root, "node_modules"))))) return { kind: "npm", command: await packageManagerTest(root), timeoutSec: 180 };
  if (await findFile(root, async (name, full) => /\.test\.[mc]?js$/.test(name) && /node:test/.test(await fs.readFile(full, "utf8").catch(() => "")))) {
    return { kind: "node", command: ["node", "--test"], timeoutSec: 90 };
  }
  // pytest: test_*.py or *_test.py, run with the project's own environment when it has one.
  const rootTestPy = (await exists(path.join(root, "tests.py"))) ? "tests.py" : (await exists(path.join(root, "test.py"))) ? "test.py" : "";
  if (rootTestPy || (await findFile(root, (name) => /^(test_.*|.*_test)\.py$/.test(name)))) {
    const venv = [".venv/bin/python", "venv/bin/python"].map((p) => path.join(root, p));
    let py = "python3";
    for (const v of venv) if (await exists(v)) { py = v; break; }
    // Only when pytest is installed for that Python: otherwise every version would "fail" for no reason.
    if (!(await canRun(py, ["-m", "pytest", "--version"]))) return null;
    // The interpreter that was just checked, by its full path: the sandbox the tools run in has its own PATH, where
    // a bare `python3` can be another Python without pytest (measured: run_tests said "0 passed, 1 failed").
    if (py === "python3") py = (await whichOnPath("python3")) ?? py;
    // A lone test.py / tests.py at the root is not collected by pytest's default patterns: name it.
    return { kind: "pytest", command: [py, "-m", "pytest", "-q", "--no-header", "-p", "no:cacheprovider", ...(rootTestPy && !(await findFile(root, (name) => /^(test_.*|.*_test)\.py$/.test(name))) ? [rootTestPy] : [])], timeoutSec: 180 };
  }
  if (await exists(path.join(root, "go.mod"))) return { kind: "go", command: ["go", "test", "-count=1", "-v", "./..."], timeoutSec: 240 };
  if (await exists(path.join(root, "Cargo.toml"))) return { kind: "cargo", command: ["cargo", "test"], timeoutSec: 300 };
  if (await makeHasTest(root)) return { kind: "make", command: ["make", "test"], timeoutSec: 240 };
  return null;
}

async function makeHasTest(root: string): Promise<boolean> {
  const text = await fs.readFile(path.join(root, "Makefile"), "utf8").catch(() => "");
  return /^test\s*:/m.test(text);
}

/**
 * Passed and failed counts and the failed tests' names from a run's output, for TAP (node:test), jest, vitest,
 * mocha and pytest. `errored` is the runner's own verdict (non-zero exit, a timeout): when the output names no
 * failure, an errored run still counts as one.
 */
export function readTestOutput(output: string, errored: boolean): { passed: number; failed: number; failedNames: string[] } {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  const num = (re: RegExp) => { const m = re.exec(plain); return m ? Number(m[1]) : null; };
  // A "# SKIP" or "# TODO" result is neither a pass nor a failure.
  let passed = (plain.match(/^ok \d+ - (?![^\n]*#[ \t]*(?:SKIP|TODO)\b)/gim) ?? []).length;
  let failed = (plain.match(/^not ok \d+ - (?![^\n]*#[ \t]*(?:SKIP|TODO)\b)/gim) ?? []).length;
  const names = [...plain.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  // node:test summary, TAP ("# pass 84") or spec reporter ("ℹ pass 84"): the most reliable count when present.
  const sumPass = num(/^[ \t]*[#ℹ]\s*pass (\d+)[ \t]*$/m), sumFail = num(/^[ \t]*[#ℹ]\s*fail (\d+)[ \t]*$/m);
  if (sumPass !== null || sumFail !== null) {
    passed = sumPass ?? 0; failed = sumFail ?? 0;
    for (const m of plain.matchAll(/^[ \t]*✖\s+(.+?)(?:\s+\([\d.]+m?s\))?[ \t]*$/gm)) if (!/^failing tests:?$/i.test(m[1])) names.push(m[1]);
  } else if (!passed && !failed && /^[ \t]*[✔✖]\s/m.test(plain)) {
    // node:test spec reporter without the summary (cut off): count the result lines.
    passed = (plain.match(/^[ \t]*✔\s/gm) ?? []).length;
    failed = (plain.match(/^[ \t]*✖\s/gm) ?? []).length;
  }
  if (!passed && !failed && /^[ \t]*--- (?:PASS|FAIL): /m.test(plain)) {
    // go test -v: one "--- PASS: TestX (0.00s)" or "--- FAIL: TestX" per top-level test (subtests are indented and counted with them).
    for (const m of plain.matchAll(/^--- (PASS|FAIL): (\S+)/gm)) { if (m[1] === "PASS") passed++; else { failed++; names.push(m[2]!); } }
  }
  if (!passed && !failed && /^test result: /m.test(plain)) {
    // cargo test (libtest): "test result: FAILED. 2 passed; 1 failed; ..." once per test binary.
    for (const m of plain.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed/gm)) { passed += Number(m[1]); failed += Number(m[2]); }
    for (const m of plain.matchAll(/^test (\S+) \.\.\. FAILED[ \t]*$/gm)) names.push(m[1]!);
  }
  if (!passed && !failed) {
    // jest: "Tests:       1 failed, 5 passed, 6 total"; vitest: "Tests  1 failed | 5 passed (6)".
    const line = /^[ \t]*Tests:?\s+.*$/m.exec(plain)?.[0] ?? "";
    if (line) { passed = Number(/(\d+) passed/.exec(line)?.[1] ?? 0); failed = Number(/(\d+) failed/.exec(line)?.[1] ?? 0); }
    // mocha: "5 passing", "1 failing".
    else if (/^[ \t]*\d+ passing\b/m.test(plain)) { passed = num(/^[ \t]*(\d+) passing\b/m) ?? 0; failed = num(/^[ \t]*(\d+) failing\b/m) ?? 0; }
    // pytest: "2 failed, 5 passed in 0.12s" (either part may be missing).
    else if (/\b\d+ (passed|failed|error)s?\b.* in [\d.]+s/.test(plain)) { passed = num(/(\d+) passed/) ?? 0; failed = (num(/(\d+) failed/) ?? 0) + (num(/(\d+) errors?\b/) ?? 0); }
    for (const m of plain.matchAll(/^[ \t]*●\s+(.+?)[ \t]*$/gm)) if (!/^Console$/.test(m[1])) names.push(m[1]);       // jest
    for (const m of plain.matchAll(/^[ \t]*(?:FAIL|×|✗)\s+(.+?)(?:\s+\d+ms)?[ \t]*$/gm)) names.push(m[1]);             // vitest
    for (const m of plain.matchAll(/^FAILED\s+(\S+)/gm)) names.push(m[1]);                                       // pytest
  }
  if (errored && !failed) failed = 1;
  return { passed, failed, failedNames: [...new Set(names)] };
}

/**
 * For a project with no tests: a runner for the checks Apex writes from the request. JavaScript runs them with
 * node:test; Python with pytest when it is installed for the project's Python. Null for anything else.
 */
export async function checksOnlyRunner(root: string): Promise<TestRunner | null> {
  const names = async (dir: string) => fs.readdir(dir).catch(() => [] as string[]);
  const top = await names(root);
  const src = await names(path.join(root, "src"));
  if (top.includes("package.json") || [...top, ...src].some((n) => /\.(m?js|cjs)$/.test(n))) return { kind: "node", command: ["node", "--test"], timeoutSec: 60 };
  if (top.some((n) => n === "pyproject.toml" || n === "requirements.txt" || n === "setup.py" || /\.py$/.test(n)) || src.some((n) => /\.py$/.test(n))) {
    let py = "python3";
    for (const v of [".venv/bin/python", "venv/bin/python"].map((p) => path.join(root, p))) if (await exists(v)) { py = v; break; }
    if (await canRun(py, ["-m", "pytest", "--version"])) return { kind: "pytest", command: [py, "-m", "pytest", "-q", "--no-header", "-p", "no:cacheprovider"], timeoutSec: 120 };
  }
  return null;
}

/** What one run of a command produced. `failed`: it did not exit with 0 (an error exit, a timeout, a stop, too much output, or it never started). */
export interface CommandResult { stdout: string; stderr: string; exitCode: number | null; failed: boolean; timedOut: boolean; aborted: boolean }

/**
 * Runs a command to its end and returns what it printed. The command gets its own process group, and the whole
 * group is killed when the run times out, is stopped, prints more than `maxBuffer`, or when the command itself has
 * exited: a test command's children (a server a test started, a watcher, `npm test`'s node) used to live on after a
 * timeout, holding the copy's folder and a port.
 */
export function runCommand(file: string, args: string[], o: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number; signal?: AbortSignal }): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (o.signal?.aborted) { resolve({ stdout: "", stderr: "", exitCode: null, failed: true, timedOut: false, aborted: true }); return; }
    const max = o.maxBuffer ?? 8 << 20;
    const group = process.platform !== "win32";
    let child: import("node:child_process").ChildProcess;
    // On Windows npm, npx, yarn and pnpm are .cmd files, which spawn cannot start without a shell.
    const cmdShim = process.platform === "win32" && /^(?:npm|npx|yarn|pnpm|bun)$/i.test(file);
    const q = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
    try { child = cmdShim ? spawn(file, args.map(q), { cwd: o.cwd, env: o.env, shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }) : spawn(file, args, { cwd: o.cwd, env: o.env, detached: group, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
    catch (err) { resolve({ stdout: "", stderr: `${file}: ${err instanceof Error ? err.message : String(err)}`, exitCode: null, failed: true, timedOut: false, aborted: false }); return; }
    let stdout = "", stderr = "", size = 0;
    let timedOut = false, aborted = false, overflow = false, done = false;
    const killAll = () => {
      // The group (negative pid): the command and everything it started. A group that is already gone throws ESRCH.
      if (group && child.pid) { try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* gone, or not a group leader */ } }
      if (process.platform === "win32" && child.pid) { try { spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); return; } catch { /* gone */ } }
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    };
    const take = (which: "out" | "err") => (chunk: Buffer | string) => {
      if (overflow) return;
      const text = String(chunk);
      size += text.length;
      if (size > max) { overflow = true; killAll(); return; }
      if (which === "out") stdout += text; else stderr += text;
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", take("out"));
    child.stderr?.on("data", take("err"));
    const timer = o.timeoutMs && o.timeoutMs > 0 ? setTimeout(() => { timedOut = true; killAll(); }, o.timeoutMs) : null;
    const onAbort = () => { aborted = true; killAll(); };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (exitCode: number | null, startError?: string) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr: startError ? `${stderr}${file}: ${startError}` : stderr, exitCode, failed: exitCode !== 0 || timedOut || aborted || overflow, timedOut, aborted });
    };
    child.on("error", (err) => { killAll(); finish(null, err.message); });
    // The command is done: what it left running goes too (it also holds the output pipes open, so "close" would wait for it).
    child.on("exit", () => killAll());
    child.on("close", (code) => finish(code));
  });
}

/**
 * The sandbox for code a model wrote that Apex runs itself (a version's tests, the checks written from a request,
 * probe scripts), on macOS (Seatbelt). Such a run happens in a scratch copy, so it needs little:
 *  - files: it may write only inside `writable` (the copy), the temporary folders and the package managers' caches;
 *    it may not read the usual places for keys and logins (~/.ssh, cloud and registry credentials, keychains, the
 *    apps' own data under ~/Library/Application Support);
 *  - network: this machine only (tests start servers on localhost); nothing leaves it;
 *  - it may not open apps, script them, or call ssh, launchctl or the keychain tool.
 * Reads are otherwise open: interpreters, virtual environments and node_modules live all over a home folder, and a
 * narrower rule stopped test runners from starting (the reason run_tests has an outside-the-sandbox fallback).
 * `readable`: folders that stay readable even under a denied place (the project itself, when it is kept there).
 */
export function testSandboxProfile(o: { writable: string[]; readable?: string[]; /** Folders that stay read-only even inside a writable place (the real project's node_modules, linked into the copy). */ readOnly?: string[]; home?: string; env?: NodeJS.ProcessEnv }): string {
  if (process.platform === "linux") return linuxSandboxSpec(o);
  if (process.platform === "win32") return winSandboxSpec(o);
  const env = o.env ?? process.env;
  const real = (p: string) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
  const q = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
  const home = o.home ?? env.HOME ?? os.homedir();
  const h = home ? real(home) : "";
  const inHome = (...rel: string[]) => (h ? rel.map((r) => path.join(h, r)) : []);
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny network-outbound)",
    '(allow network-outbound (remote ip "localhost:*"))',
    ...["/usr/bin/osascript", "/usr/bin/open", "/bin/launchctl", "/usr/bin/launchctl", "/usr/sbin/launchctl", "/usr/bin/security", "/usr/bin/ssh", "/usr/bin/scp", "/usr/bin/sftp", "/usr/sbin/chroot"].map((b) => `(deny process-exec (literal ${q(b)}))`),
    "(deny lsopen)",
    "(deny appleevent-send)",
    "(deny file-write*)",
    '(allow file-write* (subpath "/dev"))',
  ];
  const temp = [...new Set([real(os.tmpdir()), "/private/tmp", "/private/var/tmp"])];
  const caches = [
    ...inHome(".npm", ".cache", ".yarn", ".pnpm-store", "Library/Caches", "Library/pnpm", "go/pkg", ".cargo/registry", ".cargo/git"),
    // macOS's per-user cache folder (/var/folders/xx/yyyy/C), the sibling of the temporary folder: compilers and Python write there.
    path.join(path.dirname(real(os.tmpdir())), "C"),
    ...[env.GOCACHE, env.GOMODCACHE, env.UV_CACHE_DIR, env.XDG_CACHE_HOME, env.npm_config_cache].filter((v): v is string => Boolean(v && path.isAbsolute(v))),
  ].filter((p) => existsSync(p)).map(real);
  for (const dir of inHome(".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker", ".config/gcloud", ".config/gh", ".config/op", ".claude", ".codex", ".gemini", ".cursor", ".config/github-copilot", ".config/anthropic", ".openai", "Library/Keychains", "Library/Cookies", "Library/Application Support", "Library/Mail", "Library/Messages", "Library/Safari")) lines.push(`(deny file-read* (subpath ${q(dir)}))`);
  for (const file of inHome(".netrc", ".npmrc", ".pypirc", ".git-credentials", ".yarnrc.yml", ".cargo/credentials", ".cargo/credentials.toml", ".pgpass", ".vault-token", ".zsh_history", ".bash_history", ".python_history", ".node_repl_history")) lines.push(`(deny file-read* (literal ${q(file)}))`);
  // Dotfiles directly in the home folder (shell profiles with exported tokens, tool configs, histories) are not readable,
  // except the few that test tools need. Folders such as ~/.nvm or ~/.cargo keep working: only the entries at the top are covered.
  if (h) {
    const rx = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    lines.push(`(deny file-read-data (regex #"^${rx}/\\.[^/]+$"))`);
    for (const f of inHome(".gitconfig", ".gitignore_global", ".gitignore", ".nvmrc", ".node-version", ".tool-versions", ".python-version", ".ruby-version", ".editorconfig")) lines.push(`(allow file-read-data (literal ${q(f)}))`);
    for (const d of inHome(".nvm", ".volta", ".fnm", ".asdf", ".pyenv", ".rbenv", ".rustup", ".cargo", ".bun", ".deno", ".local", ".config", ".cache", ".npm", ".yarn", ".pnpm-store", ".gradle", ".m2", ".sdkman")) lines.push(`(allow file-read-data (literal ${q(d)}))`);
  }
  // After the denials (the last matching rule wins): the copy, the temporary folders and the caches.
  for (const dir of [...temp, ...caches]) lines.push(`(allow file-write* (subpath ${q(dir)}))`);
  // Local sockets a test opens for itself; not the ones elsewhere (an ssh agent, Docker).
  for (const dir of temp) lines.push(`(allow network-outbound (subpath ${q(dir)}))`);
  // Read-only places come before the writable ones, so a cache folder inside one can still be opened for writing below.
  for (const dir of (o.readOnly ?? []).filter((p) => existsSync(p)).map(real)) lines.push(`(deny file-write* (subpath ${q(dir)}))`);
  for (const dir of (o.readable ?? []).map(real)) if (dir !== "/" && !(h && (dir === h || h.startsWith(dir + path.sep)))) lines.push(`(allow file-read* (subpath ${q(dir)}))`);
  for (const dir of o.writable.map(real)) if (dir !== "/" && !(h && (dir === h || h.startsWith(dir + path.sep)))) lines.push(`(allow file-read* (subpath ${q(dir)}))`, `(allow file-write* (subpath ${q(dir)}))`, `(allow network-outbound (subpath ${q(dir)}))`);
  return lines.join("\n") + "\n";
}

/**
 * Linux: bubblewrap (bwrap). The same promises as the macOS profile, in bwrap's terms: the whole filesystem read-only, writable
 * only in the copy, the temporary folders and the package managers' caches; the usual places for keys and logins hidden;
 * no network except this machine (a fresh network namespace with a loopback, so tests can start servers on localhost);
 * its own process tree, killed with the parent. The "profile" is a JSON spec that inTestSandbox turns into bwrap arguments.
 */
const BWRAP_PREFIX = "bwrap:";
function linuxSandboxSpec(o: { writable: string[]; readable?: string[]; readOnly?: string[]; home?: string; env?: NodeJS.ProcessEnv }): string {
  const env = o.env ?? process.env;
  const real = (p: string) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
  const home = real(o.home ?? env.HOME ?? os.homedir());
  const inHome = (...rel: string[]) => rel.map((r) => path.join(home, r));
  const temp = [...new Set([real(os.tmpdir()), "/tmp", "/var/tmp"])].filter((p) => existsSync(p));
  // A fresh machine (a CI runner) has no ~/.cache: without one Go, pip and others cannot create their caches inside the sandbox.
  try { mkdirSync(path.join(home, ".cache"), { recursive: true }); } catch { /* read-only home: tools fall back to their own errors */ }
  const caches = [...inHome(".npm", ".cache", ".yarn", ".pnpm-store", "go/pkg", ".cargo/registry", ".cargo/git"), ...[env.GOCACHE, env.GOMODCACHE, env.UV_CACHE_DIR, env.XDG_CACHE_HOME, env.npm_config_cache].filter((v): v is string => Boolean(v && path.isAbsolute(v)))].filter((p) => existsSync(p)).map(real);
  const hideDirs = inHome(".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker", ".config/gcloud", ".config/gh", ".config/op", ".claude", ".codex", ".gemini", ".cursor", ".config/github-copilot", ".config/anthropic", ".openai").filter((p) => existsSync(p));
  const hideFiles = inHome(".netrc", ".npmrc", ".pypirc", ".git-credentials", ".yarnrc.yml", ".cargo/credentials", ".cargo/credentials.toml", ".pgpass", ".vault-token", ".zsh_history", ".bash_history", ".python_history", ".node_repl_history").filter((p) => existsSync(p));
  const writable = [...new Set([...temp, ...caches, ...o.writable.map(real)])].filter((p) => p !== "/" && p !== home);
  const readOnly = (o.readOnly ?? []).filter((p) => existsSync(p)).map(real);
  const own = o.writable.map(real);
  return BWRAP_PREFIX + JSON.stringify({ writable, hideDirs, hideFiles, readOnly, own });
}

let bwrapProbe: Promise<boolean> | null = null;
function linuxSandboxAvailable(): Promise<boolean> {
  return (bwrapProbe ??= runCommand("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-net", "--unshare-pid", process.execPath, "-e", "process.exit(0)"], { cwd: os.tmpdir(), timeoutMs: 15_000 }).then((r) => !r.failed, () => false));
}
function inLinuxSandbox(spec: string, file: string, args: string[]): { file: string; args: string[] } {
  const { writable, hideDirs, hideFiles, readOnly = [], own = [] } = JSON.parse(spec.slice(BWRAP_PREFIX.length)) as { writable: string[]; hideDirs: string[]; hideFiles: string[]; readOnly?: string[]; own?: string[] };
  const a = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-net", "--unshare-pid", "--die-with-parent", "--new-session"];
  for (const d of hideDirs) a.push("--tmpfs", d);
  for (const f of hideFiles) a.push("--ro-bind", "/dev/null", f);
  for (const w of writable) a.push("--bind", w, w);
  // The real project's node_modules stays read-only even when the project sits in a writable place; cache folders inside it are bound writable again.
  for (const r of readOnly) { a.push("--ro-bind", r, r); for (const w of own) if (w.startsWith(r + path.sep)) a.push("--bind", w, w); }
  return { file: "bwrap", args: [...a, file, ...args] };
}

/** A trial run of Node inside the AppContainer: exits cleanly, can write in its own folder, cannot write outside it. */
async function windowsSandboxProbe(): Promise<boolean> {
  try {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-wsb-"));
    const outside = path.join(os.homedir(), `.apex-sandbox-probe-${process.pid}.txt`);
    const js = `require("fs").writeFileSync("inside.txt","x");try{require("fs").writeFileSync(${JSON.stringify(outside)},"x");process.exit(3)}catch(e){process.exit(0)}`;
    const { file, args } = inWindowsSandbox(winSandboxSpec({ writable: [dir] }), process.execPath, ["-e", js]);
    const r = await runCommand(file, args, { cwd: dir, env: { ...process.env }, timeoutMs: 60_000 });
    await fs.rm(outside, { force: true }).catch(() => undefined);
    const ok = !r.failed && existsSync(path.join(dir, "inside.txt"));
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return ok;
  } catch { return false; }
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
let sandboxProbe: Promise<boolean> | null = null;
/**
 * Whether test runs can be sandboxed here: macOS with sandbox-exec, and a trial run of this Node inside the profile
 * exits cleanly (asked once per process). APEX_TEST_SANDBOX=0 turns it off. False keeps runs as they were, unsandboxed.
 */
export function testSandboxAvailable(): Promise<boolean> {
  if (process.env.APEX_TEST_SANDBOX === "0") return Promise.resolve(false);
  if (process.platform === "linux") return linuxSandboxAvailable();
  if (process.platform === "win32") return (sandboxProbe ??= windowsSandboxProbe());
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) return Promise.resolve(false);
  return (sandboxProbe ??= runCommand(SANDBOX_EXEC, ["-p", testSandboxProfile({ writable: [] }), process.execPath, "-e", "process.exit(0)"], { cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...(process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE } : {}) }, timeoutMs: 10_000 })
    .then((r) => !r.failed, () => false));
}

/** `file args` as a command inside the test sandbox. */
export function inTestSandbox(profile: string, file: string, args: string[]): { file: string; args: string[] } {
  if (profile.startsWith(BWRAP_PREFIX)) return inLinuxSandbox(profile, file, args);
  if (profile.startsWith(WIN_PREFIX)) return inWindowsSandbox(profile, file, args);
  return { file: SANDBOX_EXEC, args: ["-p", profile, file, ...args] };
}
