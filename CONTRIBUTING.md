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
locally running app instead of the hosted one, create a local profile with
`onyx login --local` and switch between profiles with
`onyx profile use <name>`; `onyx status` and `onyx developer status` print the
current API target.

## Pull Requests

- Keep changes focused.
- Add or update tests for behavior changes.
- Preserve local/offline behavior under `.git/onyx/`.
- Do not add private Onyx app, Supabase, WorkOS, or GitHub App dependencies to
  this public package.
- Update `/Users/ted/onyx/docs` when public CLI behavior, flags, local state,
  sync semantics, install flow, or bundled skill guidance changes.
