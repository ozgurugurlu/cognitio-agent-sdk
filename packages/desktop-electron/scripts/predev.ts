import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.COGNITIO_CHANNEL ?? "dev"}`

await $`cd ../runtime && bun script/build-node.ts`
