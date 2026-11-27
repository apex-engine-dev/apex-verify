import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ModelClient, ModelEvent } from "apex-verify-engine";
import { verify } from "./verify.js";
import { parseVerifyArgs } from "./verify-cmd.js";
import { renderBadge, renderMarkdown, renderSarif, renderText, exitCode } from "./report.js";
import { lastUserPrompt } from "./hook.js";
import { handle } from "./mcp.js";

// Tests never touch the real cache in the home folder.
const TEST_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "apex-vt-cache0-"));
process.env.APEX_CACHE_DIR = TEST_CACHE;
const TASK = "slugify should replace spaces with dashes and lower-case the text";
const CHECKS = "```js\nimport { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { slugify } from \"../src/slug.js\";\ntest(\"replaces spaces with dashes\", () => { assert.equal(slugify(\"Hello Big World\"), \"hello-big-world\"); });\ntest(\"lower-cases\", () => { assert.equal(slugify(\"ABC\"), \"abc\"); });\n```";

const fake = (text = CHECKS): ModelClient => ({
  async *stream(): AsyncIterable<ModelEvent> { yield { type: "text-delta", text } as ModelEvent; yield { type: "usage", inputTokens: 10, outputTokens: 10 } as ModelEvent; yield { type: "done" } as ModelEvent; },
});

function repo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "apex-vt-"));
  fs.mkdirSync(path.join(d, "src")); fs.mkdirSync(path.join(d, "test"));
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "p", type: "module", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(d, "src/slug.js"), "export function slugify(s) { return String(s).toLowerCase(); }\n");
  fs.writeFileSync(path.join(d, "test/slug.test.js"), "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { slugify } from \"../src/slug.js\";\ntest(\"lower\", () => { assert.equal(slugify(\"A\"), \"a\"); });\ntest(\"empty\", () => { assert.equal(slugify(\"\"), \"\"); });\n");
  const g = (...a: string[]) => execFileSync("git", ["-C", d, ...a], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q"); g("add", "-A"); g("commit", "-q", "-m", "init");
  return d;
}
const write = (d: string, f: string, c: string) => fs.writeFileSync(path.join(d, f), c);

test("a correct change is READY: checks fail on the old code, pass on the new, tests pass", async () => {
  const d = repo();
  write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim().replace(/\\s+/g, \"-\"); }\n");
  const r = await verify({ dir: d, task: TASK, checker: { client: fake(), model: "m" }, cache: false });
  assert.equal(r.verdict, "ready", JSON.stringify(r.reasons));
  assert.equal(r.checks.failedOnOldCode, true);
  assert.equal(r.checks.failed, 0);
  assert.ok(r.checks.passed >= 2);
  assert.equal(exitCode(r.verdict), 0);
  assert.match(renderText(r), /READY/);
});

test("the same task on the same code reuses its checks instead of asking the model again", async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "apex-vt-cache-"));
  process.env.APEX_CACHE_DIR = cache;
  try {
    const d = repo();
    write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim().replace(/\\s+/g, \"-\"); }\n");
    const first = await verify({ dir: d, task: TASK, checker: { client: fake(), model: "m" } });
    assert.equal(first.verdict, "ready");
    const boom: ModelClient = { async *stream(): AsyncIterable<ModelEvent> { throw new Error("the model must not be called"); } };
    const second = await verify({ dir: d, task: TASK, checker: { client: boom, model: "m" } });
    assert.equal(second.verdict, "ready");
    assert.equal(second.usage.modelCalls, 0);
  } finally { process.env.APEX_CACHE_DIR = TEST_CACHE; }
});

test("with a secret, cached checks are reused only when their MAC is valid: a planted or edited entry is ignored and the model is asked again", async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "apex-vt-mac-"));
  process.env.APEX_CACHE_DIR = cache;
  try {
    const d = repo();
    write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim().replace(/\\s+/g, \"-\"); }\n");
    const boom: ModelClient = { async *stream(): AsyncIterable<ModelEvent> { throw new Error("the model must not be called"); } };
    const first = await verify({ dir: d, task: TASK, checker: { client: fake(), model: "m", cacheSecret: "k1" } });
    assert.equal(first.verdict, "ready", JSON.stringify({ reasons: first.reasons, warnings: first.warnings, tests: first.tests }).slice(0, 1500));
    const again = await verify({ dir: d, task: TASK, checker: { client: boom, model: "m", cacheSecret: "k1" } });
    assert.equal(again.verdict, "ready"); assert.equal(again.usage.modelCalls, 0, "a re-run reuses the checks");
    const file = path.join(cache, "checks", fs.readdirSync(path.join(cache, "checks"))[0]!);
    const entry = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(typeof entry.mac, "string");
    // someone without the key replaces the checks with one that any change passes
    const body = JSON.parse(entry.body); body.code = "import { test } from \"node:test\";\ntest(\"always\", () => {});\n";
    fs.writeFileSync(file, JSON.stringify({ body: JSON.stringify(body), mac: entry.mac }));
    const forged = await verify({ dir: d, task: TASK, checker: { client: fake(), model: "m", cacheSecret: "k1" } });
    assert.ok(forged.usage.modelCalls >= 1, "the edited entry was not used");
    // an entry with no MAC at all, and one written under another key, are not trusted either
    fs.writeFileSync(file, JSON.stringify({ body: JSON.stringify(body) }));
    assert.ok((await verify({ dir: d, task: TASK, checker: { client: fake(), model: "m", cacheSecret: "k1" } })).usage.modelCalls >= 1);
    assert.ok((await verify({ dir: d, task: TASK, checker: { client: fake(), model: "m", cacheSecret: "k2" } })).usage.modelCalls >= 1, "another key's entry is not reused");
  } finally { process.env.APEX_CACHE_DIR = TEST_CACHE; }
});

test("a wrong change is NOT READY and names the failing check", async () => {
  const d = repo();
  write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().replace(/ /g, \"_\"); }\n");
  const r = await verify({ dir: d, task: TASK, checker: { client: fake(), model: "m" }, secondLook: false });
  assert.equal(r.verdict, "not_ready");
  assert.equal(r.reasons[0]!.kind, "check_failed");
  assert.match(r.reasons[0]!.evidence ?? "", /dash|hello/i);
  assert.equal(exitCode(r.verdict), 1);
  assert.match(renderMarkdown(r), /apex/);
});

// ---- #6 two checkers, #4 fresh inputs, #14 badge ----
const CHECKS_B = "```js\nimport { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { slugify } from \"../src/slug.js\";\ntest(\"spaces become one dash\", () => { assert.equal(slugify(\"One Two\"), \"one-two\"); });\ntest(\"already lower\", () => { assert.equal(slugify(\"abc\"), \"abc\"); });\n```";
const CHECKS_LENIENT = "```js\nimport { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { slugify } from \"../src/slug.js\";\ntest(\"lower-cases\", () => { assert.equal(slugify(\"ABC\"), \"abc\"); });\n```";
const WRONG = "export function slugify(s) { return String(s).toLowerCase().replace(/ /g, \"_\"); }\n";
const GOODCODE = "export function slugify(s) { return String(s).toLowerCase().trim().replace(/\\s+/g, \"-\"); }\n";
const asChecker = (text: string): ModelClient => fake(text);

test("two checkers: both object -> NOT READY, with evidence from both", async () => {
  const d = repo(); write(d, "src/slug.js", WRONG);
  const r = await verify({ dir: d, task: TASK, checker: { client: asChecker(CHECKS), model: "a" }, secondChecker: { client: asChecker(CHECKS_B), model: "b" }, secondLook: false, cache: false });
  assert.equal(r.verdict, "not_ready", JSON.stringify(r.reasons));
  assert.match(r.reasons[0]!.summary, /both checkers/);
  assert.equal(r.secondChecks?.written, true);
  assert.ok(r.secondChecks!.failed >= 1);
});

test("two checkers: only one objects -> UNKNOWN (they disagree), never ready and never a block", async () => {
  const d = repo(); write(d, "src/slug.js", WRONG);
  const r = await verify({ dir: d, task: TASK, checker: { client: asChecker(CHECKS), model: "a" }, secondChecker: { client: asChecker(CHECKS_LENIENT), model: "b" }, secondLook: false, cache: false });
  assert.equal(r.verdict, "unknown", JSON.stringify(r.reasons));
  assert.equal(r.reasons[0]!.kind, "checkers_disagree");
  assert.match(r.reasons[0]!.summary, /a found a problem, b found none/);
});

test("two checkers: neither objects -> READY", async () => {
  const d = repo(); write(d, "src/slug.js", GOODCODE);
  const r = await verify({ dir: d, task: TASK, checker: { client: asChecker(CHECKS), model: "a" }, secondChecker: { client: asChecker(CHECKS_B), model: "b" }, secondLook: false, cache: false });
  assert.equal(r.verdict, "ready", JSON.stringify(r.reasons));
});

test("two checkers: a second checker that cannot write checks is reported and the first one decides", async () => {
  const d = repo(); write(d, "src/slug.js", WRONG);
  const r = await verify({ dir: d, task: TASK, checker: { client: asChecker(CHECKS), model: "a" }, secondChecker: { client: asChecker("I cannot write tests."), model: "b" }, secondLook: false, cache: false });
  assert.equal(r.verdict, "not_ready", JSON.stringify(r.reasons));
  assert.ok(r.warnings.some((w) => /second checker \(b\) could not write usable checks/.test(w)), r.warnings.join("|"));
});

test("fresh inputs: the instruction is sent only when asked for", async () => {
  const seen: string[] = [];
  const spy: ModelClient = { async *stream(req: any): AsyncIterable<ModelEvent> { seen.push(String(req.messages?.[1]?.content ?? "")); yield { type: "text-delta", text: CHECKS } as ModelEvent; yield { type: "done" } as ModelEvent; } };
  const d = repo(); write(d, "src/slug.js", GOODCODE);
  await verify({ dir: d, task: TASK, checker: { client: spy, model: "m" }, freshInputs: true, cache: false });
  assert.ok(seen.some((x) => /do not use those same literal values/.test(x)));
  seen.length = 0;
  await verify({ dir: d, task: TASK, checker: { client: spy, model: "m" }, cache: false });
  assert.ok(seen.length > 0 && !seen.some((x) => /do not use those same literal values/.test(x)));
});

test("badge: a shields.io endpoint JSON for each verdict", () => {
  const b = (verdict: string) => JSON.parse(renderBadge({ verdict } as any));
  assert.deepEqual(b("ready"), { schemaVersion: 1, label: "apex verify", message: "ready", color: "brightgreen" });
  assert.equal(b("not_ready").color, "red");
  assert.equal(b("unknown").message, "unknown");
});

test("deleting a test to make the change pass is NOT READY, with no model needed", async () => {
  const d = repo();
  write(d, "src/slug.js", "export function slugify(s) { return 1; }\n");
  fs.rmSync(path.join(d, "test/slug.test.js"));
  const r = await verify({ dir: d, task: TASK, checker: null });
  assert.equal(r.verdict, "not_ready");
  assert.ok(r.reasons.some((x) => x.kind === "cheat" && /deleted a test file/.test(x.summary)));
});

test("a change that breaks an existing test is NOT READY", async () => {
  const d = repo();
  write(d, "src/slug.js", "export function slugify(s) { return String(s).toUpperCase(); }\n");
  const r = await verify({ dir: d, task: TASK, checker: null });
  assert.equal(r.verdict, "not_ready");
  assert.ok(r.reasons.some((x) => x.kind === "regression"));
  assert.ok(r.tests.newlyFailing.length >= 1);
});

test("a change that breaks the type check is NOT READY even though the tests pass", async () => {
  const d = repo();
  const pkg = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")); pkg.scripts.typecheck = "node check-types.mjs"; fs.writeFileSync(path.join(d, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(d, "check-types.mjs"), 'import fs from "node:fs"; const s = fs.readFileSync("src/slug.js", "utf8"); if (s.includes("MISSING_IMPORT")) { console.error("src/slug.js: error TS2307: cannot find module"); process.exit(1); }\n');
  execFileSync("git", ["-C", d, "add", "-A"]); execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "typecheck"]);
  write(d, "src/slug.js", "// MISSING_IMPORT\nexport function slugify(s) { return String(s).toLowerCase().trim(); }\n");
  const r = await verify({ dir: d, task: TASK, checker: null });
  assert.equal(r.verdict, "not_ready");
  assert.ok(r.reasons.some((x) => x.kind === "regression" && /typecheck/.test(x.summary)), JSON.stringify(r.reasons));
});

test("without a checker a clean change is UNKNOWN, never a silent pass", async () => {
  const d = repo();
  write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim(); }\n");
  const r = await verify({ dir: d, task: TASK, checker: null });
  assert.equal(r.verdict, "unknown");
  assert.ok(r.reasons.some((x) => x.kind === "no_checks"));
  assert.equal(exitCode(r.verdict), 3);
});

test("nothing changed: UNKNOWN with a clear reason; the project is never modified", async () => {
  const d = repo();
  const before = fs.readFileSync(path.join(d, "src/slug.js"), "utf8");
  const r = await verify({ dir: d, task: TASK, checker: null });
  assert.equal(r.verdict, "unknown");
  assert.equal(r.reasons[0]!.kind, "no_change");
  assert.equal(fs.readFileSync(path.join(d, "src/slug.js"), "utf8"), before);
});

test("a diff file is judged on a copy", async () => {
  const d = repo();
  const patched = fs.mkdtempSync(path.join(os.tmpdir(), "apex-vt-p-"));
  fs.cpSync(d, patched, { recursive: true, filter: (p) => !p.includes(`${path.sep}.git`) });
  write(patched, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim().replace(/\\s+/g, \"-\"); }\n");
  let diff = ""; try { execFileSync("diff", ["-ruN", "-x", ".git", d, patched], { encoding: "utf8" }); } catch (e: any) { diff = e.stdout; }
  const f = path.join(os.tmpdir(), `apex-vt-${process.pid}.diff`);
  fs.writeFileSync(f, diff.replace(new RegExp(d.replace(/[/\\]/g, "\\$&"), "g"), "a").replace(new RegExp(patched.replace(/[/\\]/g, "\\$&"), "g"), "b"));
  const r = await verify({ dir: d, task: TASK, diffFile: f, checker: { client: fake(), model: "m" } });
  assert.equal(r.change.mode, "patch");
  assert.equal(r.verdict, "ready", JSON.stringify(r.reasons));
  assert.match(fs.readFileSync(path.join(d, "src/slug.js"), "utf8"), /toLowerCase\(\); \}/);
});

test("argument parsing: key and model are required unless --no-model", () => {
  assert.throws(() => parseVerifyArgs(["do it"], {}), /GEMINI_API_KEY/);
  assert.throws(() => parseVerifyArgs([], {}), /say what/);
  const a = parseVerifyArgs(["do it", "--no-model", "--format", "json"], {});
  assert.equal(a.noModel, true);
  assert.equal(a.format, "json");
  assert.equal(parseVerifyArgs(["do it", "--provider", "openai", "--model", "m"], { OPENAI_API_KEY: "k" }).model, "m");
});

test("argument parsing: second checker, fresh inputs, badge file", () => {
  const a = parseVerifyArgs(["do it", "--model", "m1", "--second-model", "m2", "--fresh-inputs", "--badge-out", "b.json"], { GEMINI_API_KEY: "k" });
  assert.equal(a.secondModel, "m2"); assert.equal(a.freshInputs, true); assert.equal(a.badgeOut, "b.json");
  assert.throws(() => parseVerifyArgs(["do it", "--model", "m1", "--second-model", "m2", "--second-provider", "openai"], { GEMINI_API_KEY: "k" }), /OPENAI_API_KEY/);
  assert.equal(parseVerifyArgs(["do it", "--model", "m1"], { GEMINI_API_KEY: "k" }).secondModel, undefined);
});

test("SARIF and exit codes", () => {
  const r: any = { verdict: "not_ready", reasons: [{ kind: "regression", summary: "x", hint: "y" }], change: { files: [{ path: "a.js" }] } };
  const s = JSON.parse(renderSarif(r));
  assert.equal(s.version, "2.1.0");
  assert.equal(s.runs[0].results[0].level, "error");
  assert.deepEqual([exitCode("ready"), exitCode("not_ready"), exitCode("unknown")], [0, 1, 3]);
});

test("the hook finds the person's last request in the transcript", () => {
  const t = [
    JSON.stringify({ type: "user", message: { role: "user", content: "first request" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "fix the csv parser\n<system-reminder>ignore</system-reminder>" }] } }),
  ].join("\n");
  assert.equal(lastUserPrompt(t), "fix the csv parser");
});

test("the MCP server lists and calls verify_change", async () => {
  const list = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(list.result.tools[0].name, "verify_change");
  const init = await handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.serverInfo.name, "apex");
  const d = repo();
  const call = await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "verify_change", arguments: { task: TASK, dir: d } } }, { APEX_NO_MODEL: "1" });
  assert.equal(call.result.isError, false);
  assert.equal(call.result.structuredContent.verdict, "unknown");
});

test("--lock-tests: an agent that deletes a failing test and breaks the code cannot get past the tests", async () => {
  const d = repo();
  fs.unlinkSync(path.join(d, "test/slug.test.js"));
  write(d, "src/slug.js", "export function slugify(s) { return 42; }\n");
  const r = await verify({ dir: d, task: TASK, checker: null, lockTests: true });
  assert.deepEqual(r.lockedTests, ["test/slug.test.js"]);
  assert.equal(r.verdict, "not_ready");
  assert.ok(r.reasons.some((x) => x.kind === "regression"), JSON.stringify(r.reasons));
  assert.ok(fs.existsSync(path.join(d, "test/slug.test.js")) === false, "the project itself is never touched");
});

test("signed reports: valid, changed after signing, and signed by another key", async () => {
  const { generateKey, signReport, checkReport } = await import("./sign.js");
  const d = repo();
  write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim(); }\n");
  const r = await verify({ dir: d, task: TASK, checker: null });
  const key = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "apex-key-")), "k.pem");
  const pub = generateKey(key);
  const signed = { ...r, signature: signReport(r, key) };
  assert.equal(checkReport(signed, pub).ok, true);
  assert.equal(checkReport({ ...signed, verdict: "ready" }, pub).ok, false, "the verdict was edited");
  assert.equal(checkReport(signed, generateKey(key + "2")).ok, false, "a different key than expected");
  assert.equal(checkReport(r).ok, false, "unsigned");
  assert.equal(checkReport(signed).ok, false, "no key pinned: anyone can sign");
  assert.equal(checkReport(signed, undefined, true).ok, true, "explicitly allowed");
  const forged = { ...signed, reasons: [{ kind: "no_change", summary: "edited after signing" }] };
  assert.equal(checkReport(forged as any, pub).ok, false, "reasons are covered by the signature");
  const attackerKey = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "apex-key2-")), "k.pem"); generateKey(attackerKey);
  const fake = { ...r, verdict: "ready" as const }; (fake as any).signature = signReport(fake as any, attackerKey);
  assert.equal(checkReport(fake as any, pub).ok, false, "a forged ready signed with another key is rejected when the right key is pinned");
  assert.throws(() => generateKey(key), /already exists/);
});

test("--demo: no key, a pretend agent's wrong change is caught with expected and actual, exit 0", async () => {
  const { runDemo } = await import("./demo.js");
  const lines: string[] = [];
  const code = await runDemo((s) => lines.push(s));
  const text = lines.join("\n");
  assert.equal(code, 0);
  assert.match(text, /Project tests: 2 passed/);
  assert.match(text, /NOT READY/);
  assert.match(text, /expected: hello-world/);
  assert.match(text, /actual:\s+hello-world!/);
});

test("dependencies are linked into the original code too, so the baseline test run can start", async () => {
  const d = repo();
  fs.mkdirSync(path.join(d, "node_modules/dep"), { recursive: true });
  fs.writeFileSync(path.join(d, "node_modules/dep/index.js"), "module.exports = 1;\n");
  write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim(); }\n");
  const { collectChange } = await import("./verify.js");
  const c = await collectChange({ dir: d });
  try {
    assert.ok(fs.existsSync(path.join(c.orig, "node_modules/dep/index.js")), "the baseline sees the dependencies");
    assert.ok(c.changes.every((x) => !x.path.startsWith("node_modules/")), "dependencies are not part of the change");
  } finally { await c.cleanup(); }
});

test("a baseline whose tests could not run is not used to call a failure new", async () => {
  const d = repo();
  // Every test failed before the change too (a broken environment); the change does not fix or break anything.
  fs.writeFileSync(path.join(d, "test/slug.test.js"), "import { test } from \"node:test\";\ntest(\"needs the network\", () => { throw new Error(\"ECONNREFUSED\"); });\n");
  execFileSync("git", ["-C", d, "add", "-A"]); execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "broken tests"]);
  write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim(); }\n");
  const r = await verify({ dir: d, task: TASK, checker: null });
  assert.ok(!r.reasons.some((x) => x.kind === "regression"), JSON.stringify(r.reasons));
});

test("a diff that names a path outside the project, an absolute path or a symlink is refused before anything is applied", async () => {
  const d = repo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "apex-home-"));
  const tryDiff = async (text: string) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "apex-d-")), "x.diff"); fs.writeFileSync(f, text); return verify({ dir: d, task: TASK, checker: null, diffFile: f }).then(() => "applied", (e: Error) => e.message); };
  const victim = path.join(home, "authorized_keys");
  const rel = path.relative(d, victim);
  assert.match(await tryDiff(`--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1 @@\n+evil\n`), /outside the project/);
  assert.equal(fs.existsSync(victim), false, "nothing was written outside the copy");
  assert.match(await tryDiff(`--- /dev/null\n+++ ${victim}\n@@ -0,0 +1 @@\n+evil\n`), /absolute path/);
  assert.match(await tryDiff(`diff --git a/link b/link\nnew file mode 120000\nindex 0000000..1111111\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+../../etc\n`), /symbolic link/);
  assert.match(await tryDiff("--- a/src/slug.js\n+++ b/src/slug.js\n@@ -1 +1 @@\n-x\n+y\u0000\n"), /NUL/);
});

test("a forged or damaged cached draft is ignored (path traversal, a wrong file name, a missing shape)", async () => {
  const { shapeOk } = await import("./verify.js");
  const good = { code: "x", path: "test/apex-task-check.test.js", original: { passed: 1, failed: 1, loadError: null } };
  assert.equal(shapeOk(good), true);
  assert.equal(shapeOk({ ...good, path: "../../../home/u/.zshrc" }), false);
  assert.equal(shapeOk({ ...good, path: "/etc/passwd" }), false);
  assert.equal(shapeOk({ ...good, path: "test/evil.test.js" }), false, "only a check file name is accepted");
  assert.equal(shapeOk({ ...good, path: "test/../x/apex-task-check.test.js" }), false);
  assert.equal(shapeOk({ ...good, original: undefined }), false);
  assert.equal(shapeOk({ path: good.path }), false);
});

test("the type check does not see API keys or tokens from the environment", async () => {
  const d = repo();
  const leak = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "apex-leak-")), "leaked.txt");
  const pkg = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")); pkg.scripts.typecheck = "node leak.mjs"; fs.writeFileSync(path.join(d, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(d, "leak.mjs"), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(leak)}, "KEYS:" + Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET/i.test(k)).join(","));\n`);
  execFileSync("git", ["-C", d, "add", "-A"]); execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "tc"]);
  write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim(); }\n");
  process.env.APEX_TEST_FAKE_API_KEY = "s3cret"; process.env.GH_TOKEN = "tok";
  try { await verify({ dir: d, task: TASK, checker: null }); } finally { delete process.env.APEX_TEST_FAKE_API_KEY; delete process.env.GH_TOKEN; }
  assert.ok(fs.existsSync(leak), "the type check ran");
  assert.equal(fs.readFileSync(leak, "utf8"), "KEYS:", "no key-like variable reached the type check");
});

test("secrets: a git-ignored .env is not part of the change and nothing key-shaped is sent to the model", async () => {
  const d = repo();
  fs.writeFileSync(path.join(d, ".gitignore"), ".env\n"); execFileSync("git", ["-C", d, "add", "-A"]); execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "ignore"]);
  fs.writeFileSync(path.join(d, ".env"), "API_KEY=SECRET-DOTENV-VALUE-123456789\n");
  write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim(); } // sk_live_ABCDEFGHIJKLMNOP\n");
  const sent: string[] = [];
  const client = { async *stream(req: any) { sent.push(req.messages.map((m: any) => m.content).join("\n")); yield { type: "text-delta", text: "no tests" }; yield { type: "done" }; } };
  const r = await verify({ dir: d, task: TASK, checker: { client: client as any, model: "m" }, cache: false });
  assert.ok(!r.change.files.some((f) => f.path === ".env"), "the ignored file is not a changed file");
  const all = sent.join("\n");
  assert.ok(!all.includes("SECRET-DOTENV-VALUE"), "the .env value never reaches the model");
  assert.ok(!all.includes("sk_live_ABCDEFGHIJKLMNOP"), "key-shaped strings are redacted");
});

test("markdown output cannot be broken or abused by untrusted text (links, mentions, HTML, code fences)", async () => {
  const { renderMarkdown } = await import("./report.js");
  const d = repo(); write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim(); }\n");
  const r = await verify({ dir: d, task: TASK, checker: null });
  r.reasons.push({ kind: "check_failed", summary: "x](https://evil/login) ![t](https://evil/p.png) @octocat <img src=x onerror=1>", evidence: "line 1\n```\n## injected\n```\nline 5", hint: "a\nb | c" });
  r.warnings.push("multi\nline | warning @someone");
  const md = renderMarkdown(r);
  assert.ok(!md.includes("](https://evil/login)"), md);
  assert.ok(!/<img/.test(md) && !md.includes("@octocat") && !md.includes("@someone"));
  assert.ok(/````/.test(md), "the evidence fence is longer than the backticks inside it");
  assert.ok(!md.split("\n").some((l) => l.startsWith("b |") || l === "b | c"), "newlines are collapsed");
});

test("an uncommitted new folder as --dir is compared with an empty original, not a git error", async () => {
  const d = repo();
  const sub = path.join(d, "newpkg"); fs.mkdirSync(sub); fs.writeFileSync(path.join(sub, "a.js"), "export const a = 1;\n");
  const r = await verify({ dir: sub, task: "add a", checker: null });
  assert.ok(r.change.files.some((f) => f.path === "a.js" && f.status === "added"), JSON.stringify(r.change.files));
});

test("READY does not claim the tests pass when some already failed before the change", async () => {
  const { renderText } = await import("./report.js");
  const d = repo();
  fs.writeFileSync(path.join(d, "test/slug.test.js"), "import { test } from \"node:test\";\ntest(\"already broken\", () => { throw new Error(\"x\"); });\n");
  execFileSync("git", ["-C", d, "add", "-A"]); execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "broken"]);
  write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim(); }\n");
  const r = await verify({ dir: d, task: TASK, checker: null });
  r.verdict = "ready";
  assert.doesNotMatch(renderText(r), /the tests pass/);
  assert.match(renderText(r), /already failed before/);
});

test("edits under src/build, src/target or src/coverage are seen, and such source folders are copied for the tests", async () => {
  const d = repo();
  fs.mkdirSync(path.join(d, "src/target"), { recursive: true }); fs.writeFileSync(path.join(d, "src/target/t.js"), "export const t = 1;\n");
  fs.mkdirSync(path.join(d, "src/build"), { recursive: true }); fs.writeFileSync(path.join(d, "src/build/b.js"), "export const b = 1;\n");
  execFileSync("git", ["-C", d, "add", "-A"]); execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "dirs"]);
  fs.writeFileSync(path.join(d, "src/build/b.js"), "export const b = 2;\n");
  const c = await (await import("./verify.js")).collectChange({ dir: d });
  try {
    assert.deepEqual(c.changes.map((x) => x.path), ["src/build/b.js"]);
    assert.ok(fs.existsSync(path.join(c.next, "src/target/t.js")), "a source folder named target is copied");
  } finally { await c.cleanup(); }
});

test("a symlink that leads out of the project is not copied into the scratch copy", async () => {
  const d = repo(); const outside = fs.mkdtempSync(path.join(os.tmpdir(), "apex-outside-"));
  fs.symlinkSync(outside, path.join(d, "escape"), "dir");
  write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim(); }\n");
  const c = await (await import("./verify.js")).collectChange({ dir: d });
  try { assert.equal(fs.existsSync(path.join(c.next, "escape")), false); } finally { await c.cleanup(); }
});

test(".gitattributes export-ignore cannot hide tests from the comparison (the baseline is not built with git archive)", async () => {
  const d = repo();
  fs.writeFileSync(path.join(d, ".gitattributes"), "test/ export-ignore\n");
  execFileSync("git", ["-C", d, "add", "-A"]); execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "ignore tests"]);
  fs.unlinkSync(path.join(d, "test/slug.test.js"));
  write(d, "src/slug.js", "export function slugify(s) { return 42; }\n");
  const r = await verify({ dir: d, task: TASK, checker: null });
  assert.ok(r.cheats.some((x) => /deleted|removed/i.test(x.detail) || x.kind === "test_deleted"), JSON.stringify(r.cheats));
  assert.equal(r.verdict, "not_ready");
});

test("round 2: Index:/context diffs and node_modules paths are refused; a removed '-- /path' line inside a hunk is not a file header", async () => {
  const d = repo();
  const victim = path.join(os.tmpdir(), `apex-r2-victim-${process.pid}.txt`); fs.writeFileSync(victim, "ORIGINAL\n");
  const tryDiff = async (text: string) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "apex-d2-")), "x.diff"); fs.writeFileSync(f, text); return verify({ dir: d, task: TASK, checker: null, diffFile: f }).then(() => "applied", (e: Error) => e.message); };
  assert.match(await tryDiff(`Index: ${path.relative(d, victim)}\n1c1\n< ORIGINAL\n---\n> PWNED\n`), /only unified diffs/);
  assert.match(await tryDiff(`*** ${path.relative(d, victim)}\n--- nonexist\n***************\n*** 1 ****\n! ORIGINAL\n--- 1 ----\n! PWNED\n`), /only unified diffs/);
  assert.equal(fs.readFileSync(victim, "utf8"), "ORIGINAL\n");
  assert.match(await tryDiff("--- a/node_modules/dep/index.js\n+++ b/node_modules/dep/index.js\n@@ -1 +1 @@\n-x\n+y\n"), /node_modules/);
  fs.writeFileSync(path.join(d, "q.sql"), "-- /usr/local/bin note\nselect 1;\n");
  execFileSync("git", ["-C", d, "add", "-A"]); execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "sql"]);
  assert.equal(await tryDiff("--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1 @@\n--- /usr/local/bin note\n select 1;\n"), "applied");
  fs.rmSync(victim, { force: true });
});

test("round 2: a change whose code rewrites the baseline copy is NOT READY, not 'already failed before'", async () => {
  const d = repo();
  write(d, "test/slug.test.js", "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport fs from \"node:fs\";\nimport { slugify } from \"../src/slug.js\";\ntry { fs.writeFileSync(new URL(\"../../before/src/slug.js\", import.meta.url), \"export function slugify(s) { return 42; }\\n\"); } catch {}\ntest(\"lower\", () => { assert.equal(slugify(\"A\"), \"a\"); });\n");
  write(d, "src/slug.js", "export function slugify(s) { return 42; }\n");
  const r = await verify({ dir: d, task: TASK, checker: null });
  assert.equal(r.verdict, "not_ready", JSON.stringify(r.reasons));
});

test("round 2: a test that newly breaks inside a suite that already failed is a regression", async () => {
  const d = repo();
  const suite = (digits: string, under: string) => `import { test, describe } from "node:test";\nimport assert from "node:assert/strict";\nimport { slugify } from "../src/slug.js";\ndescribe("suite", () => {\n  test("keeps digits", () => { assert.equal(slugify("A1"), "${digits}"); });\n  test("keeps underscores", () => { assert.equal(slugify("A_B"), "${under}"); });\n});\n`;
  write(d, "test/slug.test.js", suite("WRONG", "a_b"));
  execFileSync("git", ["-C", d, "add", "-A"]); execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "suite"]);
  write(d, "test/slug.test.js", suite("a1", "a_b"));
  write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().replace(/_/g, \"-\"); }\n");
  const r = await verify({ dir: d, task: TASK, checker: null });
  assert.ok(r.reasons.some((x) => x.kind === "regression"), JSON.stringify(r.reasons) + JSON.stringify(r.tests));
  assert.ok(r.tests.newlyFailing.includes("keeps underscores"), JSON.stringify(r.tests.newlyFailing));
});

test("round 2: a test command that now runs no tests is a regression when the original ran some", async () => {
  const d = repo();
  const pkg = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")); pkg.scripts.test = "node --test >/dev/null 2>&1; echo all good"; fs.writeFileSync(path.join(d, "package.json"), JSON.stringify(pkg));
  write(d, "src/slug.js", "export function slugify(s) { return 42; }\n");
  const r = await verify({ dir: d, task: TASK, checker: null });
  assert.equal(r.verdict, "not_ready", JSON.stringify(r.reasons));
});

test("round 2: a task text that looks like a mode flag is a task", async () => {
  const { hasFlag, normalizeArgv } = await import("./verify-cmd.js");
  const argv = normalizeArgv(["--task", "--version", "--dir", ".", "--no-model"]);
  assert.equal(hasFlag(argv, "--version"), false);
  assert.equal(hasFlag(normalizeArgv(["--version"]), "--version"), true);
});

test("round 2: redaction leaves code alone and catches common secret shapes", async () => {
  const { redactSecrets } = await import("./redact.js");
  for (const code of ["token = parseTokenFromHeader(req)", "secret: config.auth.jwtSecret,", "nextPageToken: response.nextPageToken", "model = 'sk-learn-pipeline-for-models-v2'"]) assert.equal(redactSecrets(code), code);
  const hit = (t: string, secret: string) => assert.ok(!redactSecrets(t).includes(secret), t);
  hit("aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCY", "wJalrXUtnFEMIK7MDENGbPxRfiCY");
  hit("DATABASE_URL=postgres://admin:hunter2pw@db.internal:5432/app", "hunter2pw");
  hit("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", "abcdefghijklmnopqrstuvwxyz012345");
  hit('password = "short1"', "short1");
  hit("glpat-AbCdEfGhIjKlMnOpQrSt", "glpat-AbCdEfGhIjKlMnOpQrSt");
  hit("key sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2M3n4", "sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2M3n4");
});

test("round 2: a typecheck that passed before and fails now is a regression whatever it prints; a sparse checkout's missing files are not deletions", async () => {
  const d = repo();
  const pkg = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")); pkg.scripts.typecheck = "node tc.mjs"; fs.writeFileSync(path.join(d, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(d, "tc.mjs"), 'import fs from "node:fs"; if (fs.readFileSync("src/slug.js", "utf8").includes("BROKEN")) { console.log("TS2304: Cannot find name x"); process.exit(2); }\n');
  fs.mkdirSync(path.join(d, "docs/tests"), { recursive: true }); fs.writeFileSync(path.join(d, "docs/tests/test_doc.py"), "def test_a():\n    assert True\n");
  execFileSync("git", ["-C", d, "add", "-A"]); execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "tc"]);
  execFileSync("git", ["-C", d, "sparse-checkout", "set", "--no-cone", "/*", "!/docs/"], { stdio: "pipe" });
  assert.equal(fs.existsSync(path.join(d, "docs/tests/test_doc.py")), false);
  write(d, "src/slug.js", "// BROKEN\nexport function slugify(s) { return String(s).toLowerCase().trim(); }\n");
  const r = await verify({ dir: d, task: TASK, checker: null });
  assert.ok(r.reasons.some((x) => x.kind === "regression" && /typecheck/.test(x.summary)), JSON.stringify(r.reasons));
  assert.ok(!r.cheats.some((x) => x.kind === "test_deleted"), JSON.stringify(r.cheats));
  assert.ok(!r.change.files.some((f) => f.path.startsWith("docs/")));
});

test("without a sandbox, a test that modifies the real node_modules makes the change NOT READY and says to reinstall", async () => {
  const d = repo();
  fs.mkdirSync(path.join(d, "node_modules/dep"), { recursive: true });
  fs.writeFileSync(path.join(d, "node_modules/dep/index.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(d, ".gitignore"), "node_modules\n");
  execFileSync("git", ["-C", d, "add", "-A"]); execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "deps"]);
  write(d, "test/slug.test.js", "import { test } from \"node:test\";\nimport fs from \"node:fs\";\ntest(\"poison\", () => { fs.writeFileSync(new URL(\"../node_modules/dep/index.js\", import.meta.url), \"module.exports = 'PWNED';\\n\"); });\n");
  process.env.APEX_TEST_SANDBOX = "0";
  try {
    const r = await verify({ dir: d, task: TASK, checker: null });
    assert.equal(r.verdict, "not_ready", JSON.stringify(r.reasons));
    assert.ok(r.reasons.some((x) => /node_modules/.test(x.summary)), JSON.stringify(r.reasons));
  } finally { delete process.env.APEX_TEST_SANDBOX; }
});

test("starter issues: token counts reach the report; a missing install is named; .apex-verify.json is read from the base commit and flags win", async () => {
  const { renderText } = await import("./report.js");
  const { parseVerifyArgs } = await import("./verify-cmd.js");
  const d = repo();
  write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim(); }\n");
  const client = { async *stream() { yield { type: "usage", inputTokens: 700, outputTokens: 10 }; yield { type: "usage", inputTokens: 700, outputTokens: 120 }; yield { type: "text-delta", text: "no tests here" }; yield { type: "done" }; } };
  const r = await verify({ dir: d, task: TASK, checker: { client: client as any, model: "m" }, cache: false, attempts: 1 });
  assert.ok(r.usage.inputTokens >= 700 && r.usage.outputTokens >= 120, JSON.stringify(r.usage));
  assert.match(renderText(r), /tokens in/);
  // dependencies declared, not installed
  const e = repo();
  fs.writeFileSync(path.join(e, "package.json"), JSON.stringify({ name: "p", type: "module", scripts: { test: "mocha" }, devDependencies: { mocha: "^10" } }));
  fs.rmSync(path.join(e, "test"), { recursive: true });
  execFileSync("git", ["-C", e, "add", "-A"]); execFileSync("git", ["-C", e, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "mocha"]);
  write(e, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim(); }\n");
  const r2 = await verify({ dir: e, task: TASK, checker: null });
  assert.ok(r2.warnings.some((w) => /dependencies are not installed/.test(w)), JSON.stringify(r2.warnings));
  // config file: committed version counts, flags win, the working copy cannot change it, unknown keys are an error
  const f = repo();
  fs.writeFileSync(path.join(f, ".apex-verify.json"), JSON.stringify({ timeout: 33, lockTests: true, testCommand: "node --test" }));
  execFileSync("git", ["-C", f, "add", "-A"]); execFileSync("git", ["-C", f, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "cfg"]);
  const a = parseVerifyArgs(["--task", "x", "--dir", f, "--no-model"], {});
  assert.equal(a.timeoutSec, 33); assert.equal(a.lockTests, true);
  assert.equal(parseVerifyArgs(["--task", "x", "--dir", f, "--no-model", "--timeout", "7"], {}).timeoutSec, 7);
  fs.writeFileSync(path.join(f, ".apex-verify.json"), JSON.stringify({ timeout: 1, testCommand: "true" }));
  assert.equal(parseVerifyArgs(["--task", "x", "--dir", f, "--no-model"], {}).timeoutSec, 33, "an uncommitted edit of the config is not used");
  execFileSync("git", ["-C", f, "checkout", "-q", "--", "."]);
  fs.writeFileSync(path.join(f, ".apex-verify.json"), JSON.stringify({ apiKey: "x" }));
  execFileSync("git", ["-C", f, "add", "-A"]); execFileSync("git", ["-C", f, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "bad"]);
  assert.throws(() => parseVerifyArgs(["--task", "x", "--dir", f, "--no-model"], {}), /unknown setting "apiKey"/);
});

// ---- 0.3.3: audit fixes ----
// Windows: the AppContainer sandbox only lets the code write inside its scratch copy, so the marker file cannot be made there.
test("0.3.3: a check that fails once and passes on a rerun is UNKNOWN (checks_flaky), never READY", { skip: process.platform === "win32" }, async () => {
  const d = repo();
  // Wrong on the first call with a space in it only (the project's own tests use none): a marker file in the temp folder (writable inside the sandbox) records it.
  const mark = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "apex-vt-flaky-")), "seen");
  write(d, "src/slug.js", `import fs from "node:fs";\nexport function slugify(s) { const ok = String(s).toLowerCase().trim().replace(/\\s+/g, "-"); if (!/ /.test(s) || fs.existsSync(${JSON.stringify(mark)})) return ok; fs.writeFileSync(${JSON.stringify(mark)}, "1"); return ok + "!"; }\n`);
  const r = await verify({ dir: d, task: TASK, checker: { client: fake(), model: "m" }, cache: false, secondLook: false });
  assert.ok(fs.existsSync(mark), "the new code ran");
  assert.equal(r.verdict, "unknown", JSON.stringify(r.reasons));
  assert.ok(r.reasons.some((x) => x.kind === "checks_flaky"), JSON.stringify(r.reasons));
});

// Windows: four extra sandboxed test runs exceed the time budget there (it errs to UNKNOWN, never READY); covered on Linux and macOS.
test("0.3.3: changing the test script to leave out a test the change broke is NOT READY", { skip: process.platform === "win32" }, async () => {
  const d = repo();
  write(d, "test/other.test.js", "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\ntest(\"other\", () => { assert.equal(1, 1); });\n");
  execFileSync("git", ["-C", d, "add", "-A"]); execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "more"]);
  write(d, "src/slug.js", "export function slugify(s) { return 42; }\n");
  const pkg = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")); pkg.scripts.test = "node --test test/other.test.js"; write(d, "package.json", JSON.stringify(pkg));
  const r = await verify({ dir: d, task: TASK, checker: null });
  assert.equal(r.verdict, "not_ready", JSON.stringify(r.reasons));
  assert.ok(r.reasons.some((x) => x.kind === "regression" && /original test command/.test(x.summary)), JSON.stringify(r.reasons));
});

test("0.3.3: test settings in pyproject.toml and package.json are part of the cheat scan", async () => {
  const { detectCheats } = await import("./cheats.js");
  const py = detectCheats([{ path: "pyproject.toml", before: "[project]\nname='x'\n[tool.pytest.ini_options]\naddopts='-q'\n", after: "[project]\nname='x'\n[tool.pytest.ini_options]\naddopts='-q --deselect tests/test_a.py::test_add'\n" }]);
  assert.ok(py.some((c) => c.kind === "test_config_changed"), JSON.stringify(py));
  const js = detectCheats([{ path: "package.json", before: JSON.stringify({ scripts: { test: "jest" } }), after: JSON.stringify({ scripts: { test: "jest" }, jest: { testPathIgnorePatterns: ["add"] } }) }]);
  assert.ok(js.some((c) => c.kind === "test_config_changed"), JSON.stringify(js));
  const same = detectCheats([{ path: "pyproject.toml", before: "[project]\nversion='1'\n", after: "[project]\nversion='2'\n" }]);
  assert.equal(same.length, 0);
});

test("0.3.3: a plain `node --test` script with tests in test/*.js (no .test. in the name) is found and run", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "apex-vt-"));
  fs.mkdirSync(path.join(d, "test"));
  write(d, "package.json", JSON.stringify({ name: "p", type: "module", scripts: { test: "node --test" } }));
  write(d, "test/a.js", "import { test } from \"node:test\";\ntest(\"a\", () => {});\n");
  const { detectTestRunner } = await import("apex-verify-engine");
  const r = await detectTestRunner(d);
  assert.deepEqual(r?.command, ["node", "--test"]);
});
