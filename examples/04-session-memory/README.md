# Close a handle and resume its conversation

Remember a database choice, close the first session handle, then resume the same session through one shared owned client.

This folder is independently copyable. It installs `cognitio-agent-sdk@2.0.0` from the public npm registry, including its native runtime; no monorepo build or global runtime installation is needed.

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
Resumed the same session: ses_...
Remembered database: PostgreSQL
```

## How it works

`session.close()` releases a local handle; it does not delete the transcript. `client.sessions.resume(sessionId)` attaches a new handle to the same server-side conversation. This example makes two model requests, each limited to one turn with `maxBudgetUsd: 0.03`. The script verifies the resumed ID and recalled value.

## Persistence lifetime

The transcript survives handle closure while this owned isolated runtime remains available. The final `client.close()` stops that runtime and removes its temporary isolated state. The printed ID cannot be reused by launching this example again. Durable cross-process persistence needs a deliberately retained runtime/data directory or a remote runtime; it is not demonstrated here. Always reapply runtime policy and callbacks after restarting a runtime.

The runtime loads no user/project instruction sources, omits environment details from the prompt, and closes in `finally`. Run `npm run check` for a syntax-only check that makes no model request.
