# Simple chat

Send one prompt and print a nonempty assistant response. No tools are enabled.

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

A short explanation of what an agent SDK does.

## How it works

`Agent.run()` creates a fresh session and returns a terminal result. Check `subtype` before using `text`; `agent.close()` shuts down its dedicated runtime in `finally`. The example allows one model turn and sets an estimated $0.03 budget.

The runtime loads no user/project instruction sources, omits environment details from the prompt, and closes in `finally`. Run `npm run check` for a syntax-only check that makes no model request.
