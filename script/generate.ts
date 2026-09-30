#!/usr/bin/env bun

import { $ } from "bun"

await $`bun ./packages/sdk/js/script/build.ts`

await $`bun dev generate > ../sdk/openapi.json`.cwd("packages/runtime")

// Low-level first, always: packages/sdk/js/script/build.ts regenerates the spec
// AND its own client, and the agent-sdk client is generated from that same
// committed spec. Regenerating them out of order, or in separate commits, lets
// the two vendored trees diverge.
await $`bun ./packages/agent-sdk/script/generate-client.ts`

await $`./script/format.ts`
