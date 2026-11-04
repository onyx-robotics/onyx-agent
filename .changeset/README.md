# Changesets

A change people will notice comes with a changeset: a file here that says how it bumps the
version and, in a sentence or two, what changed for someone using the package. It becomes the
changelog's entry.

```md
---
"@onyx-robotics/agent": patch
---

What changed, for someone using the package, in a sentence or two.
```

`patch` for fixes, `minor` for something new (and, while the version is 0.x, for anything that
breaks), `major` from 1.0 on for what breaks. In this repo, `bunx changeset` writes one for you.

When it's time for a release, a maintainer turns the changesets into the next version and the
changelog in Onyx's monorepo (`bun run agent:version`); once that's synced here, the release
workflow publishes the version to npm and attaches the `onyx` binaries to a GitHub release. See
[changesets.dev](https://changesets.dev) for more.
