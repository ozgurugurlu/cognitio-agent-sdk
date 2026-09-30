/**
 * The vendored cognitio HTTP client.
 *
 * `gen/**` is generated — regenerate with `bun run generate:client`, never edit
 * by hand, and `bun run check:client` (also asserted by `test/packaging.test.ts`)
 * will fail if it drifts from `packages/sdk/openapi.json`. `client.ts`,
 * `process.ts` and `server.ts` are hand-written files vendored from
 * `@cognitio/sdk`; `resolve-binary.ts`, `platform-packages.ts` and
 * `runtime-version.ts` are this package's own.
 *
 * This barrel is deliberately explicit rather than `export *`: it is the entire
 * vendored surface the rest of the SDK is allowed to see, in one reviewable
 * list.
 *
 * **Import the runtime values from here and nowhere else.** `server.ts` throws
 * the `ChildTerminationError` defined in `./process.js`, and
 * `transport/spawn.ts` narrows on it with `instanceof`. A second copy of the
 * class — for example one imported from `@cognitio/sdk` — would make that
 * check silently false, and the caller would delete the scratch HOME/XDG world
 * of a child that is still running.
 */

export { createCognitioClient, CognitioClient, type CognitioClientConfig } from "./client.js"
export { ChildTerminationError, createCognitioServer, type ServerOptions, type SpawnServerRequest } from "./server.js"
export {
  PLATFORM_PACKAGE_PREFIX,
  PLATFORM_PACKAGE_SCOPE,
  PLATFORM_TARGETS,
  platformCandidate,
  platformPackageName,
  serverBinaryFileName,
  type PlatformTarget,
} from "./platform-packages.js"
export {
  resolveServerBinary,
  type BinarySource,
  type ResolveBinaryInput,
  type ResolvedServerBinary,
} from "./resolve-binary.js"
export { EXPECTED_SERVER_VERSION } from "./runtime-version.js"
export type * from "./gen/types.gen.js"
