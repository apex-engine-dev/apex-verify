# Codex stop-hook evidence (2026-11-23)

The CLI end-to-end suite exercises the Codex-shaped stop-hook payload against a
real changed checkout. It sends the JSON contract (`cwd`, `transcript_path`,
and `session_id`) and observes a `decision: "block"` response for a deliberately
incorrect change, including the failing check. The test also confirms that the
hook stops blocking after its configured limit.

Run from the repository root:

```sh
npm install
npm run build
node --test packages/cli/dist/e2e.test.js
```

The relevant test is `the stop hook blocks 'done' for a wrong change...` in
`packages/cli/src/e2e.test.ts`. Cursor's `workspace_roots` and
`followup_message` contract is covered by the adjacent test. This evidence is
for the CLI protocol; a maintainer still needs to approve the project hook in
their installed Codex app before enabling it for a real session.
