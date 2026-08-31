# Contributing

Thanks for helping improve the Onyx agent package.

## Development

Use Bun 1.3.x or newer:

```bash
bun install
bun run typecheck
bun run lint
bun test
```

Keep the `onyx` command primitive-oriented. Workflow policy belongs in the
bundled `skills/onyx/SKILL.md` file and in repo-local `onyx/onyx.md`, not in a
large hidden runner.

Use `onyx developer link .` and `onyx developer use dev` when you want the
installed `onyx` command and managed skill files to follow this checkout.
Developer mode does not change which app the CLI targets — the API URL still
comes from the active profile (or `--api-url`/`ONYX_API_URL`). To log to a
locally running app instead of the hosted one, create a local OAuth session with
`onyx login --local` and switch between profiles with
`onyx profile use <name>`; `onyx status` and `onyx developer status` print the
current API target.

## Regenerating embedded skill and prompt content

The canonical skill source is `skills/onyx/SKILL.md` and the canonical worker
prompt is `prompts/worker-agent-prompt.md`. Both are embedded into release
builds as fallbacks, so regenerate the embedded copies after editing them:

```bash
bun run generate:skill-content
bun run generate:worker-prompt-content
```

The worker prompt is a static Markdown file: it carries no interpolated values
and dereferences no environment variables. It may name bootstrap variables such
as `PATH`, `ONYX_WORKER_CONTEXT`, and `ONYX_HOME`, but worker identity,
credentials, paths, and deadlines live only in the runtime context and the
session-state brief.

## Release builds

Release binaries are built from Bun standalone executables:

```bash
ONYX_POSTHOG_KEY=phc_production_project_token \
  ONYX_POSTHOG_HOST=https://e.onyxresearch.ai \
  bun run build:release
```

The release workflow reads the public production project token from the
`ONYX_POSTHOG_KEY` GitHub Actions secret. Source builds remain telemetry-off,
and the build keeps the token and all analytics code out of `onyx-worker`.

## Telemetry

Official Onyx releases collect one structured outcome event per allowlisted
user command; the first eligible interactive command prints a one-time notice.
Events never include arguments, environment variables, local paths, repository
identity, refs or commits, code, diffs, prompts, research content, metric
names or values, credentials, exception text, or worker output. No analytics
runs in `onyx-worker`, CI, testbed/synthetic-worker environments,
developer/source builds, or non-production API profiles. Delivery is best
effort with a 250 ms shutdown budget and cannot change a command's exit code.

```bash
onyx telemetry status
onyx telemetry disable
onyx telemetry enable
```

`ONYX_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` always disable collection.
The full policy lives in the public docs under `reference/telemetry`.

## Custom harness contract (experimental)

`onyx research run --worker-command "<cmd>"` replaces the built-in provider
launchers with your own worker process. The contract is intentionally small
and may still change:

- The command runs via `sh -lc` with the working directory set to the project
  root inside the worker's disposable worktree.
- Bare `onyx-worker` resolves to the supervisor-pinned wrapper (first on
  `PATH`); run it by name and pass no identity flags.
- `onyx-worker research session-state-brief --json` is the data API for
  identity, assignment, campaign, progress, deadline, and stop guidance.
  `onyx-worker diagnostics handshake` prints version, protocol, and
  capability metadata.
- `ONYX_WORKER_CONTEXT` is a bootstrap implementation detail consumed by
  `onyx-worker`; do not parse the context file. The scoped worker credential
  stays internal to the CLI and must never be read or forwarded by the
  harness.
- No worker prompt is delivered to custom commands — the harness brings its
  own agent behavior and follows the standard flow: `onyx-worker exp run`,
  one commit, `onyx-worker exp run --resume`, then `onyx-worker exp log`.
- The legacy per-value `ONYX_*` identity, path, and deadline variables were
  removed deliberately and will not return.

## Pull Requests

- Keep changes focused.
- Add or update tests for behavior changes.
- Preserve local/offline behavior under `.git/onyx/`.
- Do not add private Onyx app, Supabase, WorkOS, or GitHub App dependencies to
  this public package.
- Update the public docs in the `docs/` directory of the onyx-research repo
  when public CLI behavior, flags, local state, sync semantics, install flow,
  or bundled skill guidance changes.
