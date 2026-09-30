# Contributing

Use Node.js 22 or newer and the Bun version pinned in the root `package.json`. Install workspace dependencies from the repository root:

```sh
bun install --frozen-lockfile
```

The SDK lives in `packages/agent-sdk`; the runtime lives in `packages/runtime`. Run checks from the relevant package, never `bun test` at the repository root.

```sh
bun run --cwd packages/agent-sdk typecheck
bun run --cwd packages/agent-sdk test
bun run --cwd packages/runtime typecheck
bun run --cwd packages/runtime test:sharded
```

After runtime route or schema changes, regenerate the HTTP clients in order:

```sh
bun ./packages/sdk/js/script/build.ts
bun run --cwd packages/agent-sdk generate:client
bun run --cwd packages/agent-sdk check:openapi
bun run --cwd packages/agent-sdk check:client
```

Build and test the actual installed package locally:

```sh
bun run --cwd packages/agent-sdk build:binaries --single
bun run --cwd packages/agent-sdk verify:release
```

This compiles the host runtime, installs packed SDK and platform packages outside the workspace using npm and Bun, and runs Node with an empty `PATH`. It does not publish anything. Release provenance deliberately rejects artifacts built before their source was committed; ordinary development verification can still exercise them.

Keep public APIs documented and examples executable. Add regression coverage for behavior changes, using the real implementation and local transports where practical. New built-in capabilities must work through the HTTP runtime, session configuration, and SDK facade.

Submit a focused change with a description of the problem, resulting behavior, and checks run. Never commit credentials, provider authentication files, local session databases, private research, or generated binary artifacts. Release procedures are in [PUBLISHING.md](PUBLISHING.md).
