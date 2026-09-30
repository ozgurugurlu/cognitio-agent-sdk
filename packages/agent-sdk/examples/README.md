# Runnable SDK examples

For an independently installable application, start with the root [examples/](../../../examples/) projects. The files here are feature integrations that can also run from the source checkout.

These examples import the public `cognitio-agent-sdk` package. From the source checkout, install dependencies and build it first:

```sh
bun install --frozen-lockfile
bun run --cwd packages/agent-sdk build
bun run --cwd packages/agent-sdk build:binaries --single
```

The binary build is needed when running against a real provider from the checkout. It stages the binary without installing the platform package. Set `COGNITIO_BIN_PATH` to the absolute path of your host's `bin/cognitio` (`bin/cognitio.exe` on Windows) under `packages/agent-sdk/dist-binaries/`. For example, on Apple silicon macOS from the repository root:

```sh
export COGNITIO_BIN_PATH="$PWD/packages/agent-sdk/dist-binaries/cognitio-agent-sdk-darwin-arm64/bin/cognitio"
"$COGNITIO_BIN_PATH" --version
```

Use the platform directory printed by the build for other hosts. Registry users receive their platform binary automatically and do not set this variable. To copy examples into another application, install `cognitio-agent-sdk`, `zod`, and, for the external MCP example, `@modelcontextprotocol/sdk`.

Set a provider credential and choose an available model. Common provider credential variables are forwarded by the isolated spawn policy; custom credentials must be supplied through `spawn.auth`, `spawn.env`, or `spawn.passEnv`.

```sh
export ANTHROPIC_API_KEY="your-api-key"
export COGNITIO_MODEL="anthropic/claude-sonnet-4-5"
bun packages/agent-sdk/examples/01-simple.ts
```

| File                      | Behavior                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `01-simple.ts`            | Run a text-only agent and close it                                                       |
| `02-custom-tool.ts`       | Validate and execute a typed addition tool                                               |
| `03-subagent.ts`          | Delegate a real child turn and observe lifecycle events                                  |
| `04-hooks.ts`             | Observe tool hooks and answer an unresolved permission request                           |
| `05-structured-output.ts` | Validate model output against a Zod schema                                               |
| `06-session-resume.ts`    | Close a handle and resume its persisted transcript                                       |
| `07-mcp-external.ts`      | Start a separate local HTTP MCP service and call its multiplication tool                 |
| `08-remote.ts`            | Use an existing runtime and delete the example's owned session                           |
| `09-auto-permissions.ts`  | Classify a read-only operation through a model                                           |
| `10-applied-settings.ts`  | Inspect the effective runtime policy                                                     |
| `11-session-features.ts`  | Rewind a file in a disposable Git workspace, run a command, fork, and compact with hooks |

For example 08, also set `COGNITIO_BASE_URL` to an existing Cognitio runtime URL. Configure provider credentials on that server. Example 11 requires Git, creates its own temporary directory and owns a dedicated local runtime. It closes that runtime before removing the directory; customize it through `spawn` options. It does not accept a borrowed client or remote URL.

Examples export `run(options)` so applications and tests can inject a model. The other local examples also accept a borrowed client, which stays open after the example closes its Agent. Running a file directly also calls `shutdown()` at process teardown. When importing an example that uses a shared runtime into a service, the caller controls shared-runtime shutdown and must not close it while other requests are using it.

The `EXAMPLE_*` prompt labels let the deterministic provider select a reproducible response; they are ordinary prompt text and do not enable special runtime behavior. Permission hooks/classifiers only decide unresolved requests: an `allowedTools` grant can settle permission before callbacks, so examples 04 and 09 deliberately use an ask rule. Text-only examples deny all tools. The structured-output example allows the case-sensitive `StructuredOutput` tool; denying `*` would block schema submission too. Custom tools validate callback input explicitly before using it.

## Run the deterministic documentation checks

```sh
bun run --cwd packages/agent-sdk test:examples
```

The command rebuilds the SDK, imports its built public exports, starts the real runtime from source, and runs the examples against a local OpenAI-compatible endpoint. It verifies tool effects, child turns, hook dispatch, schema output, session persistence, MCP calls, remote ownership, classification, effective settings, streaming, file rewind, commands, plugins, and compaction. It requires no provider key and does not send model requests to an external provider. The source runtime and local services are closed afterward; scratch removal is asserted.

The deterministic endpoint replaces only model inference. It does not verify your provider account, model access, network, billing, or model behavior. A separate live-provider smoke is explicitly opt-in and otherwise reports a skip:

```sh
COGNITIO_EXAMPLES_LIVE=1 bun run --cwd packages/agent-sdk test:examples
```

That smoke uses your configured model, credential, and installed platform binary and can incur a provider charge. Package installation on plain Node is independently verified by `bun run --cwd packages/agent-sdk verify:release`.
