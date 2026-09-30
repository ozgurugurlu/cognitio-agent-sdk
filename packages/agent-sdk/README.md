# Cognitio Agent SDK

Build agents in TypeScript and JavaScript with tools, streaming, subagents, hooks, permissions, persistent sessions, and structured output. **Built on OpenCode.**

Cognitio packages the runtime with the SDK, so applications do not need a separately installed CLI. The high-level `Agent` and `query()` APIs sit above an HTTP runtime; `createAgentClient()` provides direct session management and remote-server connections.

## Get started

Requires Node.js 22 or newer. Bun is also supported.

```sh
npm install cognitio-agent-sdk
```

Save this as `example.mjs`. Set `ANTHROPIC_API_KEY` in your environment before running it.

```js
import { Agent } from "cognitio-agent-sdk"

const agent = new Agent({
  model: "anthropic/claude-sonnet-4-5",
  instructions: "Give clear, concise answers.",
  disallowedTools: ["*"],
  spawn: { passEnv: ["ANTHROPIC_API_KEY"] },
})

try {
  const result = await agent.run("Explain what an agent SDK does in two sentences.")
  console.log(result.text)
  console.log({ outcome: result.subtype, cost: result.totalCostUsd })
} finally {
  await agent.close()
}
```

```sh
node example.mjs
```

Choose a model available to your provider account. Model IDs use `provider/model`; known IDs have editor completion, and custom IDs are accepted. The denylist keeps this example text-only. An empty `allowedTools` list would leave tools unrestricted.

Local spawn isolates configuration, authentication-file discovery, and runtime state by default. Common provider environment variables are forwarded; use `spawn.passEnv` for additional variables or `spawn.auth` for explicit credentials. Isolation does not sandbox tools or restrict filesystem and network access. This example supplies `spawn` options and therefore owns a dedicated runtime; `agent.close()` stops it. Default Agents without connection options share a process-wide runtime that requires `shutdown()` at application teardown.

## Stream a response

```js
import { query, shutdown } from "cognitio-agent-sdk"

try {
  for await (const message of query({
    prompt: "Describe three useful agent workflows.",
    options: {
      model: "anthropic/claude-sonnet-4-5",
      disallowedTools: ["*"],
      spawn: { passEnv: ["ANTHROPIC_API_KEY"] },
    },
  })) {
    if (message.type === "result") console.log(message.text)
  }
} finally {
  await shutdown()
}
```

## Capabilities

| Area          | What you can build                                                                  |
| ------------- | ----------------------------------------------------------------------------------- |
| Agents        | One-shot runs, controllable streams, reusable sessions, multiple model providers    |
| Tools and MCP | Custom tools, built-in tool selection, external MCP connections, tool search        |
| Control       | Permission callbacks and rules, lifecycle hooks, interruption, turn and cost limits |
| Delegation    | Session-scoped subagents with their own prompts, tools, models, and MCP servers     |
| State         | Resume and fork sessions, checkpoints and file rewind, todos, transcript inspection |
| Output        | Structured JSON output, usage and cost totals, runtime events, observability        |
| Extensions    | Programmatic skills, commands, and local plugins                                    |

Capability parity with Claude Agent SDK guides development. APIs and stream shapes are Cognitio-native; consult the migration guide for supported mappings and differences.

## Documentation

The [documentation source](../docs/) contains the Mintlify site, guides, examples, migration notes, and API reference. Start with [the quickstart](../docs/quickstart.mdx).

Copy a standalone application from [examples/](../../examples/) to try chat, structured extraction, a custom tool, or conversation memory. Each project installs the public npm package independently. The [SDK feature examples](examples/) cover additional source-checkout integrations and the deterministic verification suite.

For contributors, see [CONTRIBUTING.md](../../CONTRIBUTING.md). Maintainers should read [PUBLISHING.md](../../PUBLISHING.md) for public npm release, verification, and preparing a public GitHub repository.

## Supported runtimes

The public package includes prebuilt binaries for macOS, Linux (glibc and musl), and Windows on ARM64 and x64. x64 packages use baseline binaries. Keep optional dependencies enabled; environments that manage their own runtime can use `spawn.binaryPath` or `baseUrl`.

## License and attribution

MIT. See [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE). Cognitio Agent SDK is built on [OpenCode](https://github.com/anomalyco/opencode), and is an independent project.
