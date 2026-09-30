# Cognitio runtime

The bundled runtime for **Cognitio Agent SDK**, derived from OpenCode. Applications install `cognitio-agent-sdk`; they do not publish or install this private workspace package separately.

Install workspace dependencies from the repository root:

```sh
bun install --frozen-lockfile
```

For runtime development:

```sh
bun run --cwd packages/runtime dev serve --hostname 127.0.0.1 --port 4096
bun run --cwd packages/runtime typecheck
bun run --cwd packages/runtime test:sharded
```

The server exposes its OpenAPI document at `/doc`. Configure provider credentials on the runtime host. The SDK's isolated local spawn and an independently launched development server have different configuration and storage lifetimes; see the [SDK isolation guide](../docs/defaults-and-isolation.mdx).

Build publishable SDK runtime binaries through `bun run --cwd packages/agent-sdk build:binaries`. The canonical release builder pins the model catalog and records commit/version provenance; see [PUBLISHING.md](../../PUBLISHING.md).

The Electron workspace uses `script/build-node.ts` to create a Node-compatible embedding bundle and its narrow declaration boundary. That bundle is a development integration, separate from the SDK's precompiled executable distribution.

Public guides and API references live in [packages/docs](../docs/). Run tests from this package or use the commands above; repository-root `bun test` is intentionally disabled.
