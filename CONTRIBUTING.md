# Contributing

Thanks for helping. Issues and pull requests are welcome here.

## How a change gets in

This repository is a mirror: the code is written in Onyx's private monorepo, where this directory lives beside the server it talks to, and every merge there is synced here. So a pull request here isn't merged here:

1. Open it here as usual. It's reviewed here, in public, and CI runs on it.
2. Once it's approved, a maintainer applies it in the monorepo, keeping you as its author or co-author (a `Co-authored-by:` trailer with the name and email of your commits).
3. The sync brings it back here, and the pull request is closed with a link to the commit.

Keep a pull request to one change, with a description of what it changes for someone using the package.

## Working on it

```bash
bun install
bun run lint && bun run typecheck && bun run test && bun run build
bun run format       # Prettier, width 100
bun run onyx -- help # the CLI from source
```

- **TypeScript, strict, no `any`.** Tests sit beside the code (`*.test.ts`, `bun test`). A test names the behaviour it protects and fails without the change.
- **Imports:** only this package's own files and the dependencies in `package.json` (lint checks it).
- **`src/generated/contracts` is generated** from the server's code: don't edit it. If a change needs the API to change, open an issue: the contracts change on the server first.
- **The CLI's output and exit codes are its contract:** JSON when stdout isn't a terminal, the exit codes in the README. Changing them is a breaking change.
- **A change people will notice comes with a changeset**: `bunx changeset` (see [.changeset/README.md](.changeset/README.md)).

## Security

Please report vulnerabilities privately to security@onyxresearch.ai, not in a public issue.

## License

By contributing, you agree that your contributions are licensed under the Apache License 2.0 (see [LICENSE](LICENSE)).
