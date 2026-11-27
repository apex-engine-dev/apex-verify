# Changelog

## 0.3.3 (2026-11-27)
Fixes from an audit of 0.3.2 (verdict logic, security, first-time use).
- **A flaky check is UNKNOWN, never READY.** In 0.3.2 a check that failed and then passed on a rerun was not counted, so a change that is wrong only some of the time could be READY. Now it is reported as `checks_flaky` and the verdict is UNKNOWN.
- **Editing how the tests run no longer hides a broken test.** When a change edits the test script, or test settings (package.json jest/vitest/mocha keys, `[tool.pytest]` in pyproject.toml, which the cheat scan now also reads), the original test command is run on both the old and the new code, and any test that passed before and no longer passes is a regression.
- **Plain `node --test` scripts run as written.** Projects with tests in `test/*.js` (no `.test.` in the file name) were reported as having no tests.
- **GitHub Action: the pull request's code runs sandboxed, away from the token.** The Action now installs bubblewrap on Linux and refuses to run without a sandbox (`require-sandbox: false` to allow it; `APEX_REQUIRE_SANDBOX=1` does the same for the CLI). The GitHub token moved to a separate step that only posts the result. Before, on GitHub's Linux runners the tests ran unsandboxed in a step that also held the API key and the token, so a same-repository pull request could read them. Fork pull requests were not affected (GitHub gives them no secrets).
- **GitHub Action keeps your Node.** It no longer switches the job to Node 20; a new `node-version` input sets one when needed.

## 0.3.2 (2026-11-26)
- **Flaky checks no longer block.** When a check written from the task fails, it is run once more; if it then passes, it is reported as flaky and not counted. `APEX_RERUN=0` turns this off. (No check was flaky in the benchmark runs below, so this is a safeguard, not a measured gain.)
- **Opt-in: agreement before blocking** (`APEX_VOTE=1`). When the checks find a problem, two more independent sets are written from the task, and the change is blocked only if most of them fail. On the 200 real-library changes all three sets agreed on 101 of 107 blocks; the vote overturned two blocks, one of them a false alarm, and let no wrong change through. That is too small a gain for two extra model calls on every blocked change, so it is off by default. Write-up: `benchmark/results/real-libraries-experiments`.
- Research behind both: a review of published work on AI-written tests (blind tests, fail-before/pass-after, agreement voting, flaky reruns, test tampering). Apex verify already did the strongest of these; the remaining false alarms come from checks that every independent draft writes the same way, because the task text is broader than the library's own tests.

## 0.3.1 (2026-11-25)
- **Fewer false alarms from out-of-date tests.** When a test that passed before fails now, the checker takes a second look: does the test assert exactly the old behaviour the task asks to change? It must quote the sentence of the task that says so (the quote is checked against the task). Then the verdict is `unknown` with "update the test", not `not ready`. On the 200 real-library changes: false alarms 23 to 16 of 93, wrong changes caught unchanged (106 of 107). `APEX_OUTDATED=0` turns it off.
- Benchmark: the no-key checker on real libraries (106 of 107 wrong changes caught) and two experiments that did not make it (a second draft of the checks, and a probe of behaviour the task did not ask to change: both helped on small projects, both only added false alarms on real libraries). `benchmark/results/real-libraries-experiments`, `benchmark/results/exp-two-drafts`.

## 0.3.0 (2026-11-25)
- **No API key needed:** `--provider claude-cli` and `--provider gemini-cli` write the checks with an AI CLI you are already signed in to. With no provider and no key, one is picked automatically (Gemini CLI if signed in with Google, else Claude Code). The CLI runs in a new empty folder with tools, settings, MCP servers and extensions off, and a hook never runs inside the checker's own call. Tested live with both CLIs on a right and a wrong change (`READY` and `NOT READY`).
- When the checker fails (for example a CLI that is not signed in), the report now says why instead of only "no usable checks".

## 0.2.9 (2026-11-25)
- **GitHub Action: a re-run no longer changes the verdict.** Two runs of the same code can draft different checks (25 of 200 verdicts differed in the benchmark), so "Re-run job" could flip a required check. The Action now keeps the drafted checks for a commit and reuses them on a re-run; a new commit gets a fresh draft. Raised by Gordon Chase.
- Cached checks are signed with the checker's API key, and an entry without a valid signature is ignored, so the cache cannot be used to plant checks.
- Benchmark: `run-gate.mjs` refuses to print totals for a run where every row has the same verdict, or (with a checker) most rows are `unknown` or errors. It says "NOT A RESULT" and exits 3. This is the guard against the mistake behind the withdrawn headline; suggested by Heinrich Neb.

## 0.2.8 (2026-11-23)
- **Stop hook with Gemini CLI: a retry after a block was not checked.** Gemini CLI calls the hook again with an empty prompt, so the hook had no task and stayed silent once the agent changed anything. It now keeps the session's task. Found by the experiment below.
- **New measurement** (`benchmark/results/false-alarms-real-libraries`): three attempts to cut the generated checks' false alarms on real libraries; none beat the unchanged tool, so none ships. Of the blocks counted as false alarms, about 7 in 10 are changes that really miss the task text. Two runs of the same code disagree on 25 of 200 verdicts.
- **New measurement** (`benchmark/results/hook-fix-or-game`): 120 real Gemini CLI sessions, with and without the hook. No blocked agent was seen gaming the check it was shown (0 of 12), which is too few to rule gaming out. 4 of 12 fixed the bug after the block. Two agents broke a correct change after a false block. End results with and without the hook (23 against 18 of 40) are within noise.

## 0.2.7 (2026-11-23)
- **GitHub Action**: the release-bundle download announced in 0.2.6 never ran, because GitHub does not reliably set `GITHUB_ACTION_REF` inside a composite action; the Action kept building from source (which works, about 7 seconds). The ref is now passed in explicitly, and this repository's own workflow runs the released Action so the path stays tested.

## 0.2.6 (2026-11-23)
The starter issues, each with a test.
- **Package managers**: a project with a `pnpm-lock.yaml`, `yarn.lock` or `bun.lock` has its tests run by that tool when it is installed (npm otherwise).
- **Missing install**: when a project declares dependencies and has no `node_modules`, the report says so, instead of only showing tests that fail to start.
- **Cheating scan**: skip markers of JUnit (`@Disabled`, `@Ignore`), RSpec (`pending`, `skip`, `xit`) and xUnit/NUnit (`Skip = "..."`, `[Ignore]`); and a new finding, `assertions_weakened`, when an existing test keeps its name but a strict assertion becomes a loose one or is wrapped in an empty `try`.
- **Token counts**: the report shows how many tokens the checker model used (`usage` in JSON).
- **`.apex-verify.json`**: shared settings (`provider`, `model`, `testCommand`, `timeout`, `lockTests`), read from the base commit so a change cannot edit its own rules. Flags win; an unknown key is an error.
- **GitHub Action**: on a release tag (`@v1`, `@vX.Y.Z`) the Action downloads that release's built bundle instead of building from source on every run; any other ref, or a failed download, still builds.

## 0.2.5 (2026-11-23)
- Without a sandbox, a test that modifies the project's installed dependencies (`node_modules`, which is linked into the scratch copies) now makes the change `not ready`, with a note to reinstall. With a sandbox it was already read-only.
- A generated Python check that holds a code fence inside a triple-quoted string is no longer cut short at that line.
- Windows: a test on the Windows runner proves that arguments with `&`, `^`, `%`, parentheses, pipes and quotes reach the program unchanged inside the sandbox.
- README: a real pull request comment, pasted as the tool wrote it.
- **The smaller repository announced in 0.2.3 ships now.** A publishing mistake left the removal of unreachable engine code (and the scan for private information that runs with it) out of 0.2.3 and 0.2.4. The published trees were scanned afterwards and contained nothing private; the publishing script now stops if either step did not run.

## 0.2.4 (2026-11-23)
- **Correction to published results.** A bug kept Apex verify from running the tests of a project that has a `package.json` test script, no declared dependencies and no `node_modules` (all 23 real-library benchmark tasks). Its "tests alone stopped none of the wrong changes" result on real libraries was therefore wrong. Fixed, and re-measured: the projects' own tests block 80 of 107 wrong changes (75%); the full gate 97 (91%), with 21 of 93 right changes wrongly blocked (23%). README, chart and `benchmark/results/real-projects` are corrected; the withdrawn rows are kept.
- Sandbox: the real project's `node_modules` (linked into the scratch copies) is read-only for tests, and on macOS dotfiles in the home folder (shell profiles, tool configs) are no longer readable. Windows: arguments with `&`, `^`, `%` and similar are quoted.

## 0.2.3 (2026-11-23)
A second review round, on the fixes of 0.2.1 themselves, plus a first-run polish. Every finding was reproduced first; each fix has a test.
- **`--diff` could still write outside the scratch copy** through formats the first fix did not read (`Index:` lines and context diffs, which the system `patch` follows) and into the real `node_modules` through the copy's link. Diffs are now applied with `git apply` only, non-unified formats and `node_modules`/`.git` paths are refused, and the link is taken away while a diff is applied.
- **A change could rewrite Apex verify's copy of the original code** while its tests ran, so a regression looked like "already failing". The copy is fingerprinted and a change that touches it is `not ready`.
- **Regressions that were missed**: a test that newly breaks inside a suite that already failed; a test command that now runs no tests at all (and scripts that swallow failure with `|| echo`, `; true`, `| cat` or `--passWithNoTests`); a type check that passed before and fails now, whatever it prints.
- **Cheating scan**: the comment stripping added in 0.2.2 removed Rust `#[test]`/`#[ignore]` and treated `/*` inside strings as a comment; it is now a small scanner that respects strings and languages.
- **GitHub Action**: a pull request whose title is a flag such as `--version` could pass the job without any verification; a missing report now fails the job.
- **Stop hook**: work the agent commits during the session is still verified (compared with the session's first commit, or `APEX_BASE`).
- Redaction no longer mangles code (`token = parseToken(x)`) and catches more secret shapes (URL passwords, `Bearer`, `aws_secret_access_key`, GitLab and npm tokens). Sparse checkouts and submodules are no longer reported as deletions or additions. Symlinks inside a project are copied as they are, so they cannot point back at the real files.
- **First run**: `--help` is grouped and readable, the verdict is coloured at a terminal (not when piped, and `NO_COLOR` is honoured), the demo prints a command that works, the `--no-model` hint says what to do, and the README has a complete workflow file (also in `examples/workflows/`).
- **Smaller repository**: engine code that `apex verify` never reaches is no longer published (about 7,200 lines down to about 3,000). Behaviour is unchanged; the bundle users install was already free of it.
- CI: macOS runs in its own workflow, because GitHub's macOS runners are often unavailable and that turned every run red.

## 0.2.2 (2026-11-23)
- The Action's Marketplace name is now "Apex verify: AI change checker" (the plain name is taken) and its description is shorter, so it can be listed on the GitHub Marketplace. No code changes.

## 0.2.1 (2026-11-23)
Security and robustness fixes from a full code review (four independent reviewers; every finding reproduced before it was fixed, each fix has a test).
- **A malicious `--diff` could write outside the scratch copy** (for example into `~/.zshrc`) before any sandbox ran. Diff paths are now checked (no `..`, absolute paths, drive letters or symlink creation) and `--unsafe-paths` is gone.
- **Planted or forged cached checks**: the cache and the hook's state moved to `~/.apex-verify/` (mode 700, not writable by the test sandbox), cached drafts are shape-checked and the command to run is never taken from the cache.
- **Secrets**: git-ignored files are no longer part of the change, secret-looking files are never offered to the checker, and key- and token-shaped strings are redacted from everything sent to a model. The type check now runs in the sandbox with the scrubbed environment (it used to see every key).
- **Signed reports**: the signature covers the whole report, and `--check-report` now requires the public key you trust (a forged report signed with someone else's key used to pass).
- **Stop hook**: file names with spaces or accents no longer hide changes from the fingerprint; the 3-block limit now really holds per session; the state file is private and never written through a symlink.
- **GitHub Action**: a crash or setup error now fails the job by default (it used to pass), a task starting with `--` is passed safely, a shallow checkout deepens to find the base, and only the bot's own comment is updated.
- **Engine**: a quadratic regex that could stall on blank-line output; a repository's `.gitattributes export-ignore` can no longer hide tests from the comparison; source folders named `build`, `target` or `coverage` below the root are handled; symlinks that lead out of the project are not copied; TAP `# SKIP`/`# TODO`, pytest ids with spaces, `=== CONT` and UTF-8 chunk boundaries are parsed correctly; the cheat scan no longer flags `RegExp.test(` or `cursor.skip(`, and recognises more test files; the sandbox hides more credential folders (`.claude`, `.codex`, `.gemini`, cargo credentials, shell history).
- **CLI**: `--flag=value` keeps everything after the first `=`, unknown options are rejected, a bare `--` starts the task text, model calls time out (`APEX_MODEL_TIMEOUT_SEC`, default 300 s), Ctrl-C cleans up, the MCP server answers malformed input with JSON-RPC errors, a READY no longer says "the tests pass" when some already failed, markdown reports escape untrusted text, and the Claude Code plugin is pinned to a release.

## 0.2.0 (2026-11-23)
- `--badge-out badge.svg` writes a static SVG badge (idea from the first outside pull request, #17 by DeviousCardi). A hand audit of the real-library false alarms: 6 of the 10 are changes that really miss something the task says, so the checker's mistake rate there is about 4%, not 11% (`benchmark/results/real-projects`).
- **Windows sandbox** (AppContainer; no network, writes only in the scratch copy), tested in CI. **Fixes found by running Apex verify on a real large project:** the original copy now links `node_modules` like the working copy (the baseline test run could not start), and a baseline whose tests could not run is no longer used to call failures new. **Benchmark:** 18 more real-library tasks (200 real-project changes in all): the gate blocks 80% of wrong changes there but also wrongly blocks 11% of right ones.
- **`--lock-tests`** (an agent cannot edit or delete its way to green), **signed reports** (`--sign-key`, `--gen-key`, `--check-report`), Go checks (tested on a real Go module and with a real model), and the full-pipeline cross-company measurement, which withdraws the earlier "two checkers that both object: 60%" claim (`benchmark/results/cross-vendor-full-set`).
- **Checks for Jest, Vitest (TypeScript too) and Rust** (`cargo test`), run by the project's own framework. Windows added to CI. Gemini CLI `AfterAgent` hook tested in a real session.
- **`--second-model`** (two checkers must both object), **`--fresh-inputs`**, and a **badge** (`--badge-out`, Action input `badge`). Measured: same-company second checker and fresh inputs did not improve results, so neither is default (`docs/EXPERIMENTS.md`).
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
