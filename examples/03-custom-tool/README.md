# Custom calculator tool

Give the agent a deterministic multiplication function that runs in your Node.js process. This project uses a JSON Schema and needs no schema-library dependency.

This folder is independently copyable. It installs `cognitio-agent-sdk@2.0.1` from the public npm registry, including its native runtime; no monorepo build or global runtime installation is needed.

## Run

Requires Node.js 22 or newer, npm, and an OpenAI API key. Run these commands from this project’s directory:

```sh
cp .env.example .env
# Edit .env and replace the OPENAI_API_KEY placeholder.
npm ci
npm start
```

`npm start` runs `node --env-file=.env index.mjs`. Existing shell environment values take precedence over `.env`. Never commit `.env`.

The default model is `openai/gpt-4.1-mini`. To use Anthropic, set both values in `.env`:

```dotenv
COGNITIO_MODEL=anthropic/claude-sonnet-4-5
ANTHROPIC_API_KEY=replace_with_your_key
```

`COGNITIO_MODEL` accepts other `provider/model` IDs too; configure the matching provider credentials supported by the SDK. OpenAI and Anthropic credentials are explicitly forwarded to the isolated runtime. Model availability and charges depend on your provider account. The configured USD budget is an estimate, not a billing guarantee.

## Expected output

```text
Tool result: 6 × 7 = 42
Assistant: 42
```

The assistant’s wording can vary. The script checks the actual tool callback inputs and product.

## How it works

`defineTool({ name: "multiply", ... })` becomes `sdk_multiply` in the model’s tool list. `allowedTools: ["sdk_multiply"]` permits only that tool. The callback validates finite inputs, performs the calculation, and returns JSON. The example verifies a real callback occurred before printing success, allows three model turns, and sets an estimated $0.03 budget.

The runtime loads no user/project instruction sources, omits environment details from the prompt, and closes in `finally`. Run `npm run check` for a syntax-only check that makes no model request.
