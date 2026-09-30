# Structured contact extraction

Extract a contact into a Zod-validated object. The only extra dependency is Zod 4.1.8.

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

```json
{
  "name": "Mina Patel",
  "email": "mina@example.com",
  "company": "Acme Labs"
}
```

## How it works

`defineOutputFormat(modelSchema)` gives the runtime a model-facing schema with a plain string for `email`. The stricter application schema keeps `email: z.email()`: after a successful result, `contactSchema.parse(result.structuredOutput)` checks the actual address before anything is printed. This separates a simple model-facing shape from application validation without accepting an invalid email as success.

`allowedTools: ["StructuredOutput"]` permits only the runtime’s structured-output tool. A wildcard deny rule would also block this tool. The example permits three model turns, one schema retry, and an estimated $0.03 budget.

The runtime loads no user/project instruction sources, omits environment details from the prompt, and closes in `finally`. Run `npm run check` for a syntax-only check that makes no model request.
