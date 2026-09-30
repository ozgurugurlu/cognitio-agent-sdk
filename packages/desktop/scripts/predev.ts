import { $ } from "bun"

import { copyBinaryToSidecarFolder, getCurrentSidecar, windowsify } from "./utils"

const RUST_TARGET = Bun.env.TAURI_ENV_TARGET_TRIPLE

const sidecarConfig = getCurrentSidecar(RUST_TARGET)

const binaryPath = windowsify(`../runtime/dist/${sidecarConfig.ocBinary}/bin/cognitio`)

await (sidecarConfig.ocBinary.includes("-baseline")
  ? $`cd ../runtime && bun run build --single --baseline`
  : $`cd ../runtime && bun run build --single`)

await copyBinaryToSidecarFolder(binaryPath, RUST_TARGET)
