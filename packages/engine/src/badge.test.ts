// Issue #14: the "checked by ReallyDone" badge — verdict mapping, Shields JSON,
// the static SVG, and the CLI that writes both files.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { badgeJson, badgeSvg, badgeFiles, normalizeVerdict, BADGE_LABEL } from "./badge.js";

test("badge: known verdicts pass through, anything else becomes unknown", () => {
  assert.equal(normalizeVerdict("ready"), "ready");
  assert.equal(normalizeVerdict("not_ready"), "not_ready");
  assert.equal(normalizeVerdict("unknown"), "unknown");
  assert.equal(normalizeVerdict("error"), "unknown");
  assert.equal(normalizeVerdict(""), "unknown");
  assert.equal(normalizeVerdict(undefined), "unknown");
  assert.equal(normalizeVerdict(null), "unknown");
  assert.equal(normalizeVerdict(42), "unknown");
});

test("badge: Shields endpoint JSON has the schema, label, message and color", () => {
  const ready = JSON.parse(badgeJson("ready"));
  assert.equal(ready.schemaVersion, 1);
  assert.equal(ready.label, BADGE_LABEL);
  assert.equal(ready.message, "ready");
  assert.equal(ready.color, "brightgreen");

  const notReady = JSON.parse(badgeJson("not_ready"));
  assert.equal(notReady.message, "not ready");
  assert.equal(notReady.color, "red");

  const unknown = JSON.parse(badgeJson("garbage"));
  assert.equal(unknown.message, "unknown");
  assert.equal(unknown.color, "lightgrey");
  assert.equal(unknown.label, BADGE_LABEL);
});

test("badge: the static SVG mirrors the JSON and is a self-contained image", () => {
  const svg = badgeSvg("ready");
  assert.ok(svg.startsWith("<svg "), "starts with an svg root");
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes(`aria-label="${BADGE_LABEL}: ready"`));
  assert.ok(svg.includes(`>${BADGE_LABEL}</text>`));
  assert.ok(svg.includes(">ready</text>"));
  assert.ok(svg.includes('fill="#4c1"'), "brightgreen hex");
  assert.ok(svg.includes('height="20"'));
  assert.ok(svg.trimEnd().endsWith("</svg>"));

  assert.ok(badgeSvg("not_ready").includes(">not ready</text>") && badgeSvg("not_ready").includes('fill="#e05d44"'));
  assert.ok(badgeSvg("unknown").includes(">unknown</text>") && badgeSvg("unknown").includes('fill="#9f9f9f"'));
  // width grows with the message: "not ready" is wider than "ready"
  const w = (s: string) => Number(s.match(/width="(\d+)"/)?.[1]);
  assert.ok(w(badgeSvg("not_ready")) > w(badgeSvg("ready")));
});

test("badge: XML special characters in the label are escaped", () => {
  // The label is a constant today, but the SVG builder must never emit raw markup.
  const svg = badgeSvg("ready");
  assert.ok(!svg.includes("&"), "no unescaped ampersands");
});

test("badge: badgeFiles returns exactly the two published files", () => {
  const files = badgeFiles("ready");
  assert.deepEqual(Object.keys(files).sort(), ["badge.json", "badge.svg"]);
  assert.equal(JSON.parse(files["badge.json"]).message, "ready");
  assert.ok(files["badge.svg"].startsWith("<svg"));
});

test("badge: CLI writes badge.json and badge.svg into the given directory", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "apex-badge-"));
  const cli = new URL("./badge.js", import.meta.url);
  const run = spawnSync(process.execPath, [cli.pathname, "not_ready", out], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const json = JSON.parse(fs.readFileSync(path.join(out, "badge.json"), "utf8"));
  assert.equal(json.message, "not ready");
  assert.equal(json.color, "red");
  assert.ok(fs.readFileSync(path.join(out, "badge.svg"), "utf8").includes(">not ready</text>"));
  // An unknown verdict string -> unknown badge, and the output dir is created if missing.
  const out2 = path.join(out, "nested");
  const run2 = spawnSync(process.execPath, [cli.pathname, "something-else", out2], { encoding: "utf8" });
  assert.equal(run2.status, 0, run2.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out2, "badge.json"), "utf8")).message, "unknown");
  // No verdict argument at all -> defaults to unknown too.
  const out3 = path.join(out, "no-args");
  const run3 = spawnSync(process.execPath, [cli.pathname, "unknown", out3], { encoding: "utf8" });
  assert.equal(run3.status, 0, run3.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out3, "badge.json"), "utf8")).color, "lightgrey");
  fs.rmSync(out, { recursive: true, force: true });
});
