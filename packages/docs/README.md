# Cognitio Agent SDK documentation

Mintlify documentation, generated TypeScript API reference, and runtime HTTP API.

To preview the committed documentation, run from the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd packages/docs dev
```

Open http://localhost:3333. Edits reload automatically; Ctrl+C stops the preview.

For generation and validation, build the public SDK declarations used by the snippet checks:

```sh
bun install --frozen-lockfile
bun run --cwd packages/agent-sdk build
bun run --cwd packages/docs generate
bun run --cwd packages/docs check
bun run --cwd packages/docs validate
```

The local site uses port 3333. Installation alone does not build the SDK declarations.

Edit guides in this directory. `api-reference/` is generated from the public SDK declarations. `bun run generate` synchronizes the regular `openapi.json` file with the generated runtime specification at `../sdk/openapi.json`; `bun run check` rejects a stale copy. Configure the hosted Mintlify project to use `packages/docs`; see [PUBLISHING.md](../../PUBLISHING.md#6-deploy-documentation) for the GitHub connection and deployment steps.
