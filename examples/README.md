# Cognitio Agent SDK cookbook projects

Small, independently copyable Node.js 22 projects using the public `cognitio-agent-sdk@2.0.1` package. Cognitio Agent SDK is built on OpenCode; npm installs the matching native runtime automatically.

| Project                                                  | Demonstrates                                           |
| -------------------------------------------------------- | ------------------------------------------------------ |
| [01-chat](./01-chat/README.md)                           | One prompt, nonempty text output, and cleanup         |
| [02-structured-output](./02-structured-output/README.md) | Contact extraction with a Zod schema                   |
| [03-custom-tool](./03-custom-tool/README.md)             | A real multiplication callback in your Node.js process |
| [04-session-memory](./04-session-memory/README.md)       | Closing and resuming handles on one owned runtime      |

Start with any folder, or copy that folder into a new directory. Each contains its own `package.json`, public npm lockfile, `.env.example`, and README:

```sh
cd examples/01-chat
cp .env.example .env
# Edit .env and set OPENAI_API_KEY.
npm ci
npm start
```

Each project defaults to `openai/gpt-4.1-mini`, accepts a `COGNITIO_MODEL` override, sets small turn and estimated cost limits, and cleans up its runtime. Model requests use your provider account; `npm run check` only checks syntax. Keep credentials in the ignored `.env` file or your shell.

These examples require no TypeScript compiler and no workspace dependencies. The separate `packages/agent-sdk/examples/` directory remains the SDK’s feature integration suite.
