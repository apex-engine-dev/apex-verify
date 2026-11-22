# Use Apex verify with your agent

Apex verify does not replace your agent. It checks what the agent changed. Pick the place you already work; every option runs the same command, `apex verify`.

| Where | How | Can it stop the agent from saying "done"? |
|---|---|---|
| **Any terminal** | `npx --yes https://github.com/apex-engine-dev/apex-verify/releases/latest/download/apex-verify.tgz verify "what the change should do"` | You read the verdict. Exit code 0 ready, 1 not ready, 3 unknown. |
| **Claude Code** | the Apex verify plugin (below): a Stop hook, a skill and an MCP tool | **Yes.** The hook hands the reasons back and Claude keeps working. |
| **Codex CLI** | a Stop hook and/or the MCP tool (below) | **Yes**, same mechanism. |
| **Gemini CLI** | an `AfterAgent` hook and/or the MCP tool | Yes (retry on the verdict). |
| **Cursor** | the MCP tool, plus a `stop` hook in `.cursor/hooks.json` | Partly: the hook can send a follow-up message. |
| **Aider** | `test-cmd: apex verify "<task>" --no-model` in `.aider.conf.yml` | Informs only: Aider tries a fix when the command fails. |
| **GitHub pull requests (any agent: Copilot, Cursor cloud, Codex cloud, a person)** | the Apex verify Action (below) | **Yes**, as a required check. |

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

Codex supports the same Stop hook contract. In `~/.codex/hooks.json` (or `.codex/hooks.json` in a trusted project):

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "npx --yes https://github.com/apex-engine-dev/apex-verify/releases/latest/download/apex-verify.tgz verify --hook", "timeout": 300 } ] } ] } }
```

MCP tool: `codex mcp add apex -- npx --yes https://github.com/apex-engine-dev/apex-verify/releases/latest/download/apex-verify.tgz verify --mcp`

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

**Badge.** Add `.github/workflows/badge.yml` (see this repo) to re-run the gate on every push to your default branch and publish `badge.json` / `badge.svg` on a `badge` branch. Then one line in your README shows the latest verdict — `ready` / `not ready` / `unknown`:

```md
![checked by ReallyDone](https://raw.githubusercontent.com/OWNER/REPO/badge/badge.svg)
<!-- or via Shields' endpoint support: https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/OWNER/REPO/badge/badge.json -->
```

**Fork pull requests.** GitHub withholds secrets from forks, so there Apex verify runs without a model: your tests and the cheating scan only, verdict at most `unknown`. Do **not** switch the trigger to `pull_request_target` to get secrets: that runs untrusted code with your secrets. If you want model checks on forks, run a separate privileged job that only posts the result and never executes the pull request's code.

Open-source maintainers: this is aimed at you. A PR that arrives with deleted or skipped tests, or whose behaviour does not match its description, is flagged before you spend review time.

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
