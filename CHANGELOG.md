# Changelog

## 0.2.0 (unreleased)
- **"checked by ReallyDone" README badge (#14).** `packages/engine/src/badge.ts` turns a verdict into a Shields-compatible `badge.json` plus a static `badge.svg`; `.github/workflows/badge.yml` re-runs the gate on every push to the default branch and publishes both files on a `badge` branch, so a README can show `ready` / `not ready` / `unknown` with a one-line `<img>` snippet. Tested in `badge.test.ts`.
- **Name: Apex verify** (`apex verify`). It was briefly called ReallyDone while we looked for a name; the repository is `apex-verify`.
- **Focus.** The repository is now `apex verify` and what measures it. Removed: the agent runner (`apex-agent`), model calibration and shared profiles, the uplift leaderboard scripts and the benchmark harness (`apex-bench`). The research results are kept in `docs/research/`.
- **Linux sandbox**: bubblewrap, tested in CI (write outside the copy denied, external network denied, localhost allowed). The verdict says which sandbox ran.
- **End-to-end tests** for every claimed use case through the real command line (`e2e.test.ts`), `docs/USE-CASES.md`, and a reproducible benchmark (`benchmark/run-gate.mjs`, 154 labelled changes).
- Second-vendor measurement (Claude as the checker) and the two-checkers-must-agree finding (`benchmark/results/second-vendor`).
- **New: `apex verify`.** Any agent's change in, `ready` / `not ready` / `unknown` out, with proof. An independent model writes checks from your task, shown to fail on the old code and run on the new, next to your tests and a cheating scan (deleted, skipped, focused tests; a test script that cannot fail). Output: text, JSON, Markdown (PR comment), SARIF. Exit codes 0 / 1 / 3.
- Linux: container recipe for running generated checks isolated (`docker/Dockerfile`, docs/SANDBOX.md), tested in CI. Demo GIF, social card, `docs/RELATED-WORK.md`.
- Type check: when the project has a `typecheck` script (or `tsc` and a tsconfig), errors the change introduced make it `not ready`.
- Cheating scan: warns when a task's own example value is special-cased in added code. (A "public function removed" warning was built and dropped: it fired on 10% of correct changes and on none of the wrong ones.)
- **New: Claude Code plugin** (Stop hook that blocks "done" until the change is ready, skill, MCP tool), **MCP server** (`verify --mcp`), **GitHub Action** (`action.yml`).
- **Licence: Apache-2.0** (briefly FSL-1.1 on 2026-11-22, before that PolyForm with a CLA; earlier commits were Apache-2.0 too). DCO sign-off, trademark policy (TRADEMARKS.md). A permissive licence for the code developers install, a hosted paid tier kept separate.
- Checks-writing no longer truncates for reasoning models (the output limit was cut off at about 400 characters).
- The repository is cloud-models-only; local-model paths were removed from the public build.
- Uplift study results added to the README (cheap model with and without Apex verify; not significant yet).

## 0.1.0
Earlier prototype: the engine, an agent runner and a benchmark harness (since removed).
