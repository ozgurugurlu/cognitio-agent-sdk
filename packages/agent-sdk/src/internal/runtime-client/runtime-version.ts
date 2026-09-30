/**
 * The server build this SDK release is paired with.
 *
 * Three version identities exist and are deliberately kept apart:
 *
 * | Identity                | Value                          |
 * | ----------------------- | ------------------------------ |
 * | this npm package        | `2.0.1`                 |
 * | the platform packages   | `2.0.1` (exact pins)    |
 * | the compiled server     | `1.14.19+cognitio.runtime.4`  |
 *
 * Stamping the SDK's own version into the binary would make `cognitio --version`
 * lie. Mirrors how `@anthropic-ai/claude-agent-sdk` pairs SDK `0.2.117` with CLI
 * `2.1.117` through its `claudeCodeVersion` field.
 *
 * The marker is **build metadata** (`+`), not a prerelease suffix (`-`), and
 * that choice is load-bearing: `1.14.19-p14.1` sorts *below* `1.14.19`, so a
 * plain upstream `1.14.19` would look like an available upgrade.
 * `1.14.19+cognitio.runtime.4` is semver-equal to `1.14.19`, so it cannot. The
 * `runtime.N` suffix is independent of the SDK version so an SDK-only fix does not
 * force re-identifying an unchanged runtime artifact.
 *
 * **Hard rule: never route this string through `semver` normalization.**
 * `semver.valid("1.2.3+b")` returns `"1.2.3"` — the marker would be silently
 * erased. Nothing on our path does: `GET /global/health` returns the raw
 * `COGNITIO_VERSION` compile-time define
 * (`packages/runtime/src/installation/version.ts:6`) and we compare raw
 * strings.
 *
 * A committed constant rather than a `package.json` read at runtime: this
 * package builds with plain `tsc` and has no define mechanism, and reading
 * `package.json` from `dist/` is fragile.
 *
 * `test/packaging.test.ts` pins it against `package.json.runtimeVersion` and,
 * by source-text match, against the value `script/build-server-binaries.ts`
 * stamps into `COGNITIO_VERSION` and the one the test fixture reports from
 * `/global/health`. Be precise about what that is worth: two of those legs are
 * greps rather than executions, and they catch a constant renamed out from
 * under them, not a wrong value. The execution-level proof lives elsewhere —
 * `script/publish.ts` runs the staged host binary and `script/verify-package.ts`
 * spawns it and reads `/global/health` back.
 */
export const EXPECTED_SERVER_VERSION = "1.14.19+cognitio.runtime.4"
