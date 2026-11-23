# Use Apex verify with your agent

Apex verify does not replace your agent. It checks what the agent changed. Pick the place you already work; every option runs the same command, `apex verify`.

| Where | How | Can it stop the agent from saying "done"? |
|---|---|---|
| **Any terminal** | `npx --yes https://github.com/apex-engine-dev/apex-verify/releases/latest/download/apex-verify.tgz verify "what the change should do"` | You read the verdict. Exit code 0 ready, 1 not ready, 3 unknown. |
| **Claude Code** | the Apex verify plugin (below): a Stop hook, a skill and an MCP tool | **Yes.** The hook hands the reasons back and Claude keeps working. |
| **Codex CLI** | a Stop hook and/or the MCP tool (below) | **Yes**, same mechanism. |
| **Gemini CLI** | an `AfterAgent` hook and/or the MCP tool | **Yes**, tested in a real session (below). |
| **Cursor** | a `stop` hook in `.cursor/hooks.json` (below) and/or the MCP tool | Partly: the hook sends a follow-up message. Not yet run in the app. |
| **Aider** | `test-cmd: apex verify "<task>" --no-model` in `.aider.conf.yml` | Informs only: Aider tries a fix when the command fails. |
| **GitHub pull requests (any agent: Copilot, Cursor cloud, Codex cloud, a person)** | the Apex verify Action (below) | **Yes**, as a required check. |

**Updating:** `npx` caches a URL install for good, so an `npx --yes <url>` you ran before keeps running the old version even after a new release. To update, delete the cached copy (`rm -rf ~/.npm/_npx`, it only holds npx downloads) or pin a version in the URL (`.../releases/download/v0.2.0/apex-verify.tgz`).

Install is only ever one of: the command above, `claude plugin ...`, or a workflow file.

## What you need

- Node 20 or newer, and git.
- An API key for the model that writes the checks, in `GEMINI_API_KEY` (default) or `OPENAI_API_KEY`. Use a model that is **different from, and ideally stronger than, the one your agent uses**: a model grading its own work is the failure Apex verify exists to catch. Without a key (or with `--no-model`) Apex verify still runs your tests and the cheating scan, but the verdict can be at most `unknown`.
- Your project's tests (pytest or node:test and similar are detected). Without tests Apex verify can still write checks from your task.

## Claude Code

```
/plugin marketplace add apex-engine-dev/apex-verify
/plugin install apex-verify@apex
```

Set `GEMINI_API_KEY` (or `OPENAI_API_KEY` and `APEX_CHECKER_MODEL`) in the environment Claude Code starts in. From then on, when Claude says it is done and has changed files in a git repository, Apex verify verifies the change against what you asked for in your last message:

- **READY**: a one-line note, nothing else.
- **NOT READY**: Claude is told which check failed (expected vs actual) and keeps working. At most 3 times per session (`APEX_HOOK_MAX_BLOCKS`), so a wrong check cannot trap it.
- **UNKNOWN**: you are told why; Claude is not blocked.

`APEX_MODE=warn` never blocks. Nothing runs when nothing changed, and an unchanged change is not verified twice. The plugin also gives Claude a `verify_change` tool so it can check itself mid-task, and a skill that tells it to.

Manual hook instead of the plugin (`.claude/settings.json`):

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "npx --yes https://github.com/apex-engine-dev/apex-verify/releases/latest/download/apex-verify.tgz verify --hook", "timeout": 300 } ] } ] } }
```

## Codex CLI

Codex documents the same Stop hook contract (`decision: block` plus `reason`; `stop_hook_active` is honoured). The Codex-shaped payload is covered by the CLI end-to-end suite; see [`docs/integration-evidence/codex-hook-2026-11-23.md`](integration-evidence/codex-hook-2026-11-23.md) for the command and observed behavior. Hooks added to an installed Codex app must still be trusted once with `/hooks`. In `~/.codex/hooks.json` (or `.codex/hooks.json` in a trusted project):

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "npx --yes https://github.com/apex-engine-dev/apex-verify/releases/latest/download/apex-verify.tgz verify --hook", "timeout": 300 } ] } ] } }
```

MCP tool: `codex mcp add apex -- npx --yes https://github.com/apex-engine-dev/apex-verify/releases/latest/download/apex-verify.tgz verify --mcp`

## Gemini CLI

In `.gemini/settings.json` (project) or `~/.gemini/settings.json`:

```json
{ "hooksConfig": { "enabled": true },
  "hooks": { "AfterAgent": [ { "hooks": [ { "type": "command", "command": "npx --yes https://github.com/apex-engine-dev/apex-verify/releases/latest/download/apex-verify.tgz verify --hook", "timeout": 300000 } ] } ] } }
```

Gemini sends the request as `prompt` and treats `decision: "block"` as a retry, so it works like the Claude Code hook. Tested with Gemini CLI 0.32.1: a wrong `slugify` was blocked with the failing check, the agent fixed it and finished; a correct change got `READY`. (Gemini asks you to trust project-level hooks the first time.)

## Cursor

In `.cursor/hooks.json` (project) or `~/.cursor/hooks.json`:

```json
{ "version": 1, "hooks": { "stop": [ { "command": "npx --yes https://github.com/apex-engine-dev/apex-verify/releases/latest/download/apex-verify.tgz verify --hook", "timeout": 300, "loop_limit": 3 } ] } }
```

Cursor sends `workspace_roots`, `conversation_id` and `status` (not `cwd`) and continues the agent when the hook prints `followup_message`; Apex verify detects that input and prints both `followup_message` and `decision: block`. An aborted or errored run is not verified. **Status: written to Cursor's documented hook format and tested with that input shape, but not yet run inside the Cursor app** ([#8](https://github.com/apex-engine-dev/apex-verify/issues/8)); Cursor's own forum reports stop-hook follow-ups being unreliable in some versions, so please tell us what you see.

## Any MCP client (Cursor, Gemini CLI, Claude Desktop, ...)

```json
{ "mcpServers": { "apex": { "command": "npx", "args": ["--yes", "https://github.com/apex-engine-dev/apex-verify/releases/latest/download/apex-verify.tgz", "verify", "--mcp"] } } }
```

The tool is `verify_change(task, dir?, base?)`. Add a line to your `AGENTS.md` / `CLAUDE.md` so the agent uses it: *"Before you say a task is done, call verify_change with the user's request. Never claim success on NOT READY or UNKNOWN."* (A rule file only asks; the Stop hook enforces.)

## GitHub Action (the neutral gate for every agent)

```yaml
name: Apex verify
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  apex:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: apex-engine-dev/apex-verify@v1
        with:
          api-key: ${{ secrets.GEMINI_API_KEY }}
```

It posts one comment that it updates in place, writes the job summary, and fails the job on `not_ready` (set `fail-on: unknown` to be stricter, `never` to only report). Make the job a **required status check** to gate merges. The task is the pull request's title and description.

**Fork pull requests.** GitHub withholds secrets from forks, so there Apex verify runs without a model: your tests and the cheating scan only, verdict at most `unknown`. Do **not** switch the trigger to `pull_request_target` to get secrets: that runs untrusted code with your secrets. If you want model checks on forks, run a separate privileged job that only posts the result and never executes the pull request's code.

Open-source maintainers: this is aimed at you. A PR that arrives with deleted or skipped tests, or whose behaviour does not match its description, is flagged before you spend review time.

## A "checked by Apex verify" badge

The Action can keep a badge up to date for your default branch. Give the workflow `contents: write`, run it on `push` as well as `pull_request`, and set `badge: true`:

```yaml
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: write
  pull-requests: write
# ...
      - uses: apex-engine-dev/apex-verify@v1
        with: { api-key: ${{ secrets.GEMINI_API_KEY }}, badge: true }
```

On each push to `main` it writes `apex-verify-badge.json` to the `apex-badge` branch. Then paste this into your README (public repositories; replace apex-engine-dev/apex-verify):

```md
[![Apex verify](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/apex-engine-dev/apex-verify/apex-badge/apex-verify-badge.json)](https://github.com/apex-engine-dev/apex-verify)
```

It shows `ready`, `not ready` or `unknown` for the latest push. Without a model key it is at most `unknown`. In any other CI, `apex verify "<task>" --badge-out badge.json` writes the same file.

## Locked tests and signed reports

`--lock-tests` runs your tests with the **base** version of every test file the change edited or deleted (new test files are kept). An agent that deletes or weakens a failing test, or edits a test to match broken code, gets no benefit: the original test comes back before anything runs, and the report lists the restored files (`lockedTests`). Your project folder is never touched.

`--sign-key <file>` signs the report with Ed25519 (the signature covers the verdict, the task and the proof hash of the changed files, checks and test results). Make a key with `apex verify --gen-key key.pem` (it prints the public key to share), then check a saved report with `apex verify --check-report report.json --pub-key <base64>`; any edit to the report afterwards makes it `NOT VALID`. Keep the private key where the agent cannot read it (a CI secret), and run `apex verify` in CI from the base branch's workflow, so the agent cannot change the verifier either. This is a signature on the evidence, not a sandbox: it does not stop code you run from reading the key if the key is on that machine.

## Two checkers

> Measured limits: requiring both checkers to object did **not** help, with two companies (43% caught on 101 changes, [details](../benchmark/results/cross-vendor-full-set)) or one (53%, [details](../benchmark/results/two-checkers-same-vendor)). The 60% / 2% result quoted below is from a smaller, earlier test that did not use the full pipeline. `--fresh-inputs` (checker avoids the task's own example values) also did not help ([details](../benchmark/results/fresh-inputs)); it is off by default.

`--second-model <id> [--second-provider gemini|openai|anthropic|openrouter]` adds a second, independent checker. The change is `not ready` only when **both** checkers find a problem; if only one does, the verdict is `unknown` ("the checkers disagree") and you review that objection by hand. In our first test two checkers from different companies that had to agree kept 60% of wrong changes blocked and cut false alarms to 2% (`benchmark/results/second-vendor`). Use two different companies' models if you can.

## What can go wrong, and what Apex verify does

| Situation | Behaviour |
|---|---|
| No API key | Tests and cheating scan only; verdict at most `unknown`; says so. |
| No tests in the project | Checks are written from the task; says so. |
| Nothing changed | `unknown: nothing changed`; the hook does nothing. |
| Not a git repository | Pass `--diff <file>`; otherwise a clear error. |
| The checker model writes a wrong check | A "second look" asks the model whether the check or the change is at fault; if the check, the verdict is `unknown`, not `not ready`. Measured false-alarm rate is in the README. |
| The agent edits the tests, the test script or its own configuration | Deleting, skipping, focusing tests or a test script that cannot fail makes it `not ready`; weakened assertions and config edits are warnings. |
| The agent edits Apex verify's config | Flagged. Pin the Action to a version and keep the workflow on the base branch. |
| Tests pass but nothing proves the change did anything | `unknown`, never `ready`. |
| Slow or looping | Each verification is time-boxed; the hook blocks at most 3 times per session and never when nothing changed. |

Safety note: generated checks and your tests run on your machine (macOS: a best-effort sandbox; Linux: as you). Use CI or a container for code you do not trust.
