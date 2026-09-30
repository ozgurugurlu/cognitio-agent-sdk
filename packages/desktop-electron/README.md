# Cognitio Desktop (Electron)

This workspace builds the Electron desktop application. It embeds Cognitio's Node runtime and uses the shared web application as its renderer. The public `cognitio-agent-sdk` package does not require Electron.

Use Node.js 22 or newer and the repository's pinned Bun version. Install workspace dependencies from the repository root:

```bash
bun install --frozen-lockfile
```

Start the desktop development application:

```bash
bun run --cwd packages/desktop-electron dev
```

The `predev` step copies the selected channel's icons and runs `packages/runtime/script/build-node.ts`. Electron Vite then builds the main and preload processes, starts the renderer development server, and opens the application. Native dependencies must match the host platform and Electron version.

Build the application without packaging an installer:

```bash
bun run --cwd packages/desktop-electron build
bun run --cwd packages/desktop-electron typecheck
```

The build writes `out/main`, `out/preload`, and `out/renderer`. To package an installer for the current platform, run `bun run --cwd packages/desktop-electron package` after building. Platform signing, notarization, and installer prerequisites are deployment-specific and are configured in `electron-builder.config.ts`.

The Node embedding build selects the Node HTTP, SQLite, and PTY adapters, embeds database migrations, and emits `packages/runtime/dist/node/node.js` plus WASM assets. Its checked declaration boundary is copied to `packages/runtime/dist/types/src/node.d.ts`. Electron bundles the JavaScript and copies the WASM assets into its main-process output.

The runtime can be tested without opening Electron:

```bash
bun run --cwd packages/runtime test:node
```

This compiles the Node bundle and verifies health, bootstrap/config access, native SQLite migrations, and session creation, reading, runtime settings, and deletion in a temporary workspace. It makes no model-provider requests.

`COGNITIO_CHANNEL=dev`, `beta`, or `prod` selects the desktop icon and channel profile. The default is `dev`.
