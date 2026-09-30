# Changelog

## 2.0.0 — Cognitio Agent SDK

Prepared public release; registry publication is a separate release gate.

- Rebrands the self-contained SDK to `cognitio-agent-sdk`, built on OpenCode.
  Eight `cognitio-agent-sdk-<platform>-<arch>[-musl]` packages carry the bundled
  runtime. Consumers do not need a separate OpenCode installation or package.
- Preserves isolated local defaults and supports explicit remote runtimes,
  typed callback tools, external and hosted MCP, subagents, hooks, permission
  modes, structured output, sessions, checkpoints, compaction and usage events.
- Completes model catalog generation with a committed catalog and reviewed
  provider/model maintenance automation. Ordinary builds do not fetch changing
  model metadata or bundle an unrelated web application.
- Corrects final text extraction, resume policy overrides and callback binding,
  fork ownership, remote authentication headers, optional remote session cleanup,
  compaction instructions/summary results, MCP resource/prompt validation, and
  session listing through symbolic links or canonical directory aliases.
- Pins the runtime compatibility marker to `1.14.19+cognitio.runtime.4`; the
  bundled runtime does not update itself independently of the SDK package.
- Supports independent MCP protocol clients on an SDK-owned HTTP host, including
  resources and prompts, with request cancellation and owner-wide cleanup.
- Routes all runtime logging through Effect, preserves local CLI output, and
  exports redacted operational metadata with bounded startup buffering and
  shutdown flushing for queued and in-flight log batches.
- Adds public Mintlify guides and generated API/protocol references, eleven
  executable examples using the real runtime, literal documentation snippet
  checks, and packed-install smoke verification for npm and Bun on Node 22.
- Hardens public release staging with source provenance, all-platform integrity
  checks, strict dry runs, preflight registry collision checks and platform-first
  publication. Includes upstream license notices in every published package.
- Adds a history-free public source exporter that excludes internal planning,
  research sources and deployment infrastructure, plus a public publishing guide.

The entries below describe development milestones already incorporated into
this release; they do not imply those versions were published to npm.

## 2.0.0-beta.1 — Phase 14: self-contained packaging

- **`npm install` is the only install step.** The published tarball no longer
  references `@cognitio/sdk`, and the cognitio server binary arrives with it
  as an optional platform package. Verified end to end by
  `bun run verify:package`, which packs the real tarball, installs it into a
  clean directory with **both npm and bun**, and runs it under **plain `node`
  with an empty `PATH`**.
- **The cognitio client is vendored.** `src/internal/runtime-client/`
  now holds the generated client (`gen/**`, 13,341 lines), the fetch wrapper,
  the server spawner, and the child-process helpers. Regenerate with
  `bun run generate:client`; `bun run check:client` fails if the tree drifts
  from `packages/sdk/openapi.json`, and `bun run check:openapi` fails if that
  spec drifts from the server. A timestamp-free `gen/.provenance.json` records
  the generator version and the spec's sha256.
  **This was a correctness fix, not cosmetics:** the previous `dist/**` emitted
  eight `.d.ts` and two `.js` files importing `@cognitio/sdk/v2`, and the
  dependency was declared `"@cognitio/sdk": "workspace:*"` — a protocol no
  registry install can resolve. `verify:package` packs a control tarball of
  exactly that shape and proves it fails to install outside the workspace.
  (`packages/sdk/js` does rewrite its own `exports` from `src` to `dist` at
  publish time, so the _published_ low-level SDK is usable on its own; what
  never worked was this package's dependency on it.)
- **Server binary resolution.** Four steps, in order: `spawn.binaryPath` →
  `COGNITIO_BIN_PATH` → the bundled platform package via `require.resolve` →
  `PATH`. A deliberate superset of Claude Agent SDK's chain, which has neither
  the env var nor the PATH step; dropping `PATH` would silently break every
  consumer who installs the server globally today. An explicit path that does
  not exist or is not executable **throws** rather than falling through, and a
  bare command name is rejected outright. A corrupt or permission-denied
  platform package **propagates** instead of degrading silently to `PATH`.
- **Eight platform packages,** `cognitio-agent-sdk-{platform}-{arch}[-musl]`,
  shipped as exact-pinned `optionalDependencies` and gated by `os`/`cpu` plus
  `libc` on Linux. The x64 artifact is always the **baseline** build: npm cannot
  select on CPU capability, so shipping an AVX2-requiring binary would let a
  pre-Haswell host install it and die with SIGILL. One candidate per host
  follows, so there is no AVX2 detection anywhere and no cross-libc fallback.
- **`spawn.spawnProcess`** replaces the default child spawn for containers, VMs,
  and remote hosts. It receives the already-resolved command, args, env, and
  signal, and returns a node `ChildProcess`.
- **Compatibility check on implicitly-resolved binaries.** After readiness, a
  binary found via the platform package or `PATH` must report
  `1.14.19+agent-sdk.runtime.1` from `GET /global/health`. Upstream `cognitio-*`
  builds do not implement this fork's runtime-config, control-channel, and
  checkpoint routes, and without the check they connect cleanly and then fail
  with confusing 404s. On a mismatch the child is **confirmed dead before the
  rejection lands**, so an owned scratch directory is safe to remove; an
  unconfirmed kill still surfaces as an `AggregateError` carrying
  `ChildTerminationError`, so it is preserved instead. `spawn.binaryPath`,
  `COGNITIO_BIN_PATH`, and `spawnProcess` skip the check — they are explicit
  caller choices.
- **SDK-hosted MCP runs on plain Node.** `src/tools/mcp-server.ts` moved from
  `Bun.serve` to `node:http` with the MCP SDK's `StreamableHTTPServerTransport`,
  whose options type is a literal alias of the web-standard one and which
  delegates to the same class internally — so every MCP-level response is
  unchanged. `Bun.serve` was the only Bun-only API in `src/`. Port binding also
  lost a reserve-then-rebind TOCTOU window.
- **`catalog:` specifiers no longer reach the tarball.** `zod` and `cross-spawn`
  are declared with bun's catalog protocol, which npm rejects with
  `EUNSUPPORTEDPROTOCOL`; the published manifest now resolves them to concrete
  versions, and a `workspace:` specifier fails the pack loudly rather than
  shipping. Found by running `verify:package`, not by reading the manifest.
- **The default-port test no longer binds port 4096.** It asserted the low-level
  defaults by letting a fake server bind the real default port, so it failed on
  any machine already running an cognitio-derived process. It now drives the
  spawn through `spawnProcess` and asserts the constructed arguments; the
  `port: 0` assertion stays separate and intact.
- **`ChildTerminationError` identity is now package-local.** The class this
  package throws is a different object from the one `@cognitio/sdk` exports,
  so a consumer catching the low-level one will no longer match. Nothing in this
  repo does, and the class is on this package's own public surface, but it is a
  real behavior change.
- **`optionalDependencies` exist only in published tarballs.** They are
  synthesized at pack time, because committing them would emit one 404 per
  platform on every `bun install` until the packages are published. **A git-URL
  install therefore receives no platform package** and falls back to `PATH`,
  exactly as today — the single-install promise holds for a registry or tarball
  install. The platform tarball is 30–49 MB depending on target and a complete
  darwin-arm64 install measures 107–121 MB (`du` counts shared blocks
  differently cold vs. warm); the SDK tarball itself is ~0.2 MB.
- **`engines.node` is now `>=22`**, matching `@tsconfig/node22` and what is
  actually tested, and `./package.json` was added to the `exports` map.

Fixed during review, before release — each of these was a defect in the work
above, not a pre-existing one:

- **A malformed request line could kill the host application.** The SDK-hosted
  MCP server parsed `req.url` with `new URL(url, base)`, which **throws** on a
  target node delivers verbatim: `GET //` arrives as `req.url === "//"`, and
  `new URL("//", base)` is a protocol-relative URL with an empty host. The throw
  is synchronous inside the request listener, so it became an
  `uncaughtException` — and this server runs inside **your** process, so any
  local client could terminate your application with one request. The path is
  now parsed without `URL`, and both the synchronous and asynchronous halves of
  the handler are guarded. `Bun.serve` used to absorb both for us.
- **`--publish --yes --dry-run` published for real.** `--dry-run` was accepted
  and then ignored. It now always wins.
- **A half-published release was possible.** The eight platform packages were
  published before the main package was staged, and staging can fail. Staging
  now happens first.
- **Two paths could delete a live server's scratch directory.** An abort during
  the version check swallowed `ChildTerminationError`, and a custom
  `spawnProcess` child whose `exitCode` was `undefined` was read as "already
  exited", making `close()` a no-op. Both now preserve the leak-safety contract;
  `exitCode`/`signalCode` are documented parts of the `spawnProcess` contract.
- **An installed-but-broken platform package fell through to `PATH`** and was
  then reported as "not installed". It now fails with what is actually wrong.
  Relatedly, a failure on a caller-supplied `binaryPath` no longer blames a
  bundled package the caller never asked for.
- **Musl hosts staged and verified the glibc artifact**, because the build and
  verify scripts resolved the host target without `libc`.

Escape hatches, in order of bluntness: install with `--omit=optional` and pass
`spawn.binaryPath`; set `COGNITIO_BIN_PATH`; put `cognitio` on `PATH`; or supply
`spawn.spawnProcess`. All four are covered by tests.

Known limitations: `spawn.spawnProcess` returns a node `ChildProcess`, a
deliberate Node-specific escape hatch and a known exception to the
language-neutral option rule. The staged packages carry no `LICENSE` file
because this fork's checkout has none at the repo root — a repo-level gap, not a
packaging one.

## 2.0.0-alpha.2 — Phase 13: ergonomic facade (Agent & query)

- **`Agent` facade.** Added the primary `new Agent(options)` entry point with
  one-shot `run()`, controllable `stream()`, long-lived `createSession()`,
  `resume()`, configured `fork()`, low-level `client()`, and deterministic
  `close()`. Each run/stream uses a fresh session; concurrent calls are
  independent. `RunResult.text` is required, `isError` is derived from the
  terminal subtype, and terminal `error_*` results resolve normally.
- **Headless default profile.** The no-connection facade lazily shares one
  process-global server using `isolated:true`, `127.0.0.1`, an ephemeral port,
  a 30-second timeout, automatic cleanup, disabled LSP/formatter/title-agent
  config, `settingSources:[]`, the neutral base prompt, and default denies for
  `question`, `todowrite`, and `skill`. Defined-value merging preserves
  explicit `false`, empty strings, and empty arrays. `spawn.config` merges by
  top-level key and, under `agent`, by agent name — so overriding one agent
  keeps the title agent disabled, while naming `agent.title` hands its whole
  definition (including `disable`) to the caller and restores the per-session
  title model call.
- **Tools.** `AgentOptions.tools` are exposed through one direct SDK MCP server
  as `sdk_<sanitized-name>`. Server and visible-name collisions fail during
  synchronous constructor validation.
- **`query()` migration tier.** Added a lazy, synchronous, controllable
  one-shot iterator with resume and configured fork support. The call shape is
  migration-oriented; normalized messages remain Cognitio-native. Resume
  preserves stored config and rejects unsupported overrides by field name;
  fork applies the facade profile and supports a message boundary.
- **Ownership and shutdown.** Canonical agents share one process-global client
  until `shutdown()`/`beforeExit`; explicit connection options create an
  Agent-owned dedicated client; injected clients are borrowed. Concurrent
  creation and shutdown are deduplicated, and teardown aggregates failures.
- **Stream/session lifecycle.** Abandoned single-turn result iterators release
  their SSE and active-query guard before delivery. Session close now drains
  registered in-flight stream/command/compact/todo cleanup before dispatcher
  and MCP teardown, rejects later work/mutation on the closed handle, and
  remains bounded around hostile user iterators. Calling work or mutation
  methods on a closed `Session` is now an explicit error; use
  `sessions.resume(id)` for a fresh handle.
- **Terminal text.** `ResultMessage.text` and the `{type:"result"}` envelope
  expose the final assistant message text, including partial text on applicable
  error results. Tool-only or pre-text failures leave low-level text undefined.
- **Model ergonomics.** Added an offline-generated curated `KnownModelId`
  completion union, open-ended `ModelId`, eight pure `models.*` prefix helpers,
  a committed models.dev snapshot, deterministic generation/drift checks, and
  compile-time compatibility tests for arbitrary model strings.
- **Hermetic credentials.** Extended isolated parent-env forwarding with 17
  exact provider key names needed by the curated model providers. No wildcard
  was added; `GITHUB_TOKEN` and ambient `COGNITIO_API_KEY` remain deliberately
  excluded and require explicit forwarding. Allowlist matching is now
  case-insensitive on win32, matching that platform's environment semantics.
- **Bare-spawn defaults fixed (`@cognitio/sdk` 1.20.0), a behavior change for
  every `createCognitioServer` caller.** Defaults were applied with
  `Object.assign`, which copies an explicit `undefined` over the default — so
  `createCognitioServer({ port: undefined })` produced `--port=undefined` and a
  readiness timer that fired immediately. Resolution is now nullish, and
  `port: 0` correctly means "OS-assigned ephemeral port". Known limitation: the
  frozen v1 `createCognitioServer` in `src/server.ts` still has the original
  `Object.assign` behavior and was deliberately left untouched.
- **Session operations after `client.close()` now reject** with
  `"Agent client is closed"` instead of racing a torn-down transport, and a
  configured `sessions.create` that fails while starting its SDK MCP hosts or
  applying runtime config now deletes the half-built server session instead of
  leaving it behind.
- **Low-level server lifecycle (`@cognitio/sdk` 1.20.0).**
  `ServerOptions.autoCleanup` is additive and defaults to `false`; when enabled
  it registers one process-level direct-child exit sweep and unreferences the
  ready child/stdio. Awaitable facade signal handling still owns
  SIGTERM-to-SIGKILL escalation and safe scratch removal. The synchronous exit
  sweep cannot guarantee descendant-tree cleanup or disk cleanup.

Deviations from the phase plan worth knowing when reading it:

- **`models` is a namespace, not bare helpers.** The plan promised top-level
  `anthropic()`/`openai()`; shipped as `models.anthropic(...)`. `openai/gpt-5`
  is a valid `GatewayModelId` and AI SDK v6 accepts bare model strings, so a
  mis-auto-imported `anthropic()` would type-check and silently reroute traffic
  through Vercel's gateway. A namespace cannot arrive by stray auto-import.
- **`stream()` starts lazily**, not eagerly, so a `query()` that is never
  iterated allocates no session at all. `sessionId()`, `close()`, and start
  failures behave as specified.
- **`cwd`/`directory` are rejected on a fork.** Cognitio forks clone the source
  session's directory and the route accepts no override, so the option could
  only have been silently ignored.
- **The facade sends no `systemPrompt` on create** — the neutral prompt comes
  from the create defaults. The fork path sets it explicitly, because create
  defaults do not run on forks.
- **`KnownModelId` has 808 members**, not the ~688 the plan estimated; the live
  models.dev catalog grew. The curation policy is unchanged.
- Promise-returning facade methods reject rather than throwing synchronously,
  so `agent.run(...).catch(...)` cannot miss a setup failure. `stream()` and
  `query()` still throw synchronously — they return handles, not promises.
- **`query()` is call-shape compatible with Claude Agent SDK, not
  message-shape compatible.** Claude's `mcpServers` is `sdkMcpServers` here and
  its `abortController` is `signal`, and the yielded messages stay
  Cognitio-native (`msg.text`, not Claude's `result: string` and content-block
  assistant messages). Migrating is mechanical but not import-rename-only.
- `interrupt()` is turn-scoped: on an async-iterable prompt a later turn still
  runs. Pass a `signal` and abort it to end the whole query instead.
- The facade default profile does **not** apply to a resumed session — resume
  preserves stored config by design, so a session created outside the facade
  keeps its own prompt and tool policy. Use `forkSession: true` for the
  transcript plus the facade profile.
- `autoCleanup` at the low level installs only a `process.on("exit")` sweep. A
  direct `@cognitio/sdk` consumer can therefore still orphan a server on
  Ctrl-C; the awaitable signal layer lives in the facade on purpose, so the low
  level never seizes a host's exit policy.
- `Session.close()` is bounded rather than instantaneous: an abandoned turn's
  abort request is awaited for up to about a second so an unreachable server
  cannot wedge teardown. Against a responsive server it still settles well
  under 100 ms.

Deferred (P17 candidates): arbitrary runtime-config override on `resume`,
including cloning a source session's stored config and the re-attach, rollback,
and live-handle-conflict machinery it needs; server-side fork runtime-config
cloning; an optional `session.result.finalText` envelope field; a flag to delete
facade-created sessions on close for remote/BYO servers; a scheduled models.dev
`--refresh` job.

## 2.0.0-alpha.1 — Phase 12: hermetic spawn & neutral defaults

Behavior changes first:

- **Neutral default prompt.** `sessions.create` without `systemPrompt` and
  without `instructions` now injects the brand-free `NEUTRAL_BASE_PROMPT`
  (new public export) instead of falling through to the provider coding
  prompt. `appendSystemPrompt` alone still triggers the injection — the
  append rides on the neutral base. Explicit values are preserved verbatim
  (including `instructions: ""` as an intentional empty base). Injection is
  create-only and transport-independent; `get`/`resume`/`continue`/`fork`
  never inject, and server-side `Session.fork` does not copy runtime config
  at all (pre-existing; fork cloning is a P17 candidate).
- **Strict presets.** `systemPrompt.preset` narrows to `"cognitio" | "none"`
  client-side and server-side (unknown presets were silently treated as the
  coding preset; now a client error / HTTP 400).
- **`runtimeConfig.instructions?: string`** — full custom system prompt,
  flattened to a plain string on the wire; combining it with `systemPrompt`
  is an error thrown before any request.
- **Hermetic spawn.** `spawn.isolated: true` (opt-in this phase; default in
  P15) runs `cognitio serve` with `COGNITIO_ISOLATED=1` in an SDK-owned
  scratch HOME/XDG/TMP world built from scratch: base passthrough (`PATH`,
  `SHELL`, `TERM`, locale, `LC_*`, win32 system keys), a provider/telemetry
  allowlist (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `GOOGLE_*`/`AWS_*`/`AZURE_*`/`OTEL_*` prefixes, proxy vars as a documented
  ambient exception), explicit `passEnv` names (`COGNITIO_*` rejected), and
  literal `env` overrides (reserved keys rejected with key-name-only
  errors). Parent `COGNITIO_*` values never pass implicitly.
  `spawn.auth` (typed with the generated `Auth` union via `AuthContent`) is
  injected through `COGNITIO_AUTH_CONTENT` — always set in isolated mode so
  the server never falls back to a host `auth.json`; `spawn.config` goes
  through `COGNITIO_CONFIG_CONTENT`. Isolated sessions default
  `settingSources` to `[]` when unset.
- **Guaranteed shutdown/cleanup.** Transport `close()` is memoized and awaits
  _confirmed_ child exit (SIGTERM then SIGKILL after `shutdownTimeout`, with a
  liveness probe). The SDK-owned scratch is removed **only after the child is
  confirmed dead**; if termination cannot be confirmed, `close()` rejects with
  `ChildTerminationError` and the scratch is preserved rather than deleted out
  from under a live process. `keepScratch` opts out; `scratchDir` names the
  parent dir, never touched itself. Startup failures reject only after the
  child settled — the scratch is removed when the child was reaped and
  preserved when termination was unconfirmed. The spawn `AbortSignal` triggers
  the same full cleanup, and `client.close()` runs every session's cleanup
  (`Promise.allSettled`) and the transport shutdown even when a session close
  fails, rethrowing an `AggregateError` for multiple failures.
- **`getAppliedSettings()`** reports `systemPrompt.mode: "neutral"` by
  comparing the stored config blob against `NEUTRAL_BASE_PROMPT` (works on
  re-attached handles; degrades to `"default"` after a server restart).

Server (`cognitio`):

- New fail-closed `COGNITIO_ISOLATED=1` master flag implies
  `COGNITIO_DISABLE_EXTERNAL_SKILLS` / `COGNITIO_DISABLE_PROJECT_CONFIG` /
  `COGNITIO_PURE` / `COGNITIO_DISABLE_AUTOUPDATE` /
  `COGNITIO_DISABLE_LSP_DOWNLOAD`, and additionally skips global config +
  legacy TOML migration, `~/.cognitio` and global config dirs, managed/MDM
  config, console/org fetch, remote wellknown config import (provider
  tokens still applied), and config-dir side effects (`.gitignore` writes,
  background `npm install`).
- Auth: under `COGNITIO_ISOLATED`, `COGNITIO_AUTH_CONTENT` is the sole
  authority — malformed JSON or undecodable entries raise typed errors and
  the host `auth.json` is never read. `set`/`remove` write to an in-process
  overlay (session-lifetime, no host file) so transparent OAuth refresh of a
  supplied credential still persists without leaking to disk. Non-isolated
  env content is now schema-decoded with file-path leniency instead of
  passed through raw.
- `settingSources` now gates file-discovered skills, commands, AND agents
  (session-level, provenance-aware replay): user = global config dir +
  `~/.cognitio` + `COGNITIO_CONFIG_DIR`; project = ancestor `.cognitio`
  dirs and project `cognitio.json` definitions (including JSON `mode`
  blocks); local = `skills.paths`/`skills.urls`. Direct inputs (builtins,
  MCP, `COGNITIO_CONFIG`, `COGNITIO_CONFIG_CONTENT`, console/org,
  managed/MDM, runtime, plugin) are never gated. Gated skill directories
  also leave every agent's `external_directory` whitelist, gated builtin
  overrides/disables revert to pristine, and skill discovery precedence is
  now deterministic (scan order) instead of load-completion order.
- The system-prompt skills section is omitted when runtime tool rules hide
  the skill tool or when zero skills are visible; nested AGENTS.md
  read-attachment honors the session's settingSources (including the
  synthetic file-attachment read path); the `task` tool description hides
  subagents denied by runtime tool rules.
- `deriveChildRuntime` no longer copies the parent `systemPrompt`/
  `appendSystemPrompt` onto a child agent that has its own prompt, so the
  neutral default cannot wipe specialist subagent prompts; promptless
  children (e.g. `general`) keep the inheritance. Known limitation: a
  promptless grandchild spawned _under_ a prompted subagent no longer sees
  the neutral base (the prompted level dropped it) and falls back to the
  provider base prompt — deep-subtree neutral propagation is a P17 candidate.
- New lenient, source-aware default-agent selection on the session path
  (`AgentRuntime.defaultAgent`): an invalid or gated `default_agent` falls
  back to `build`, then the first visible primary. Sessionless CLI/ACP
  routes keep the strict thrower.

Low-level `@cognitio/sdk` (1.19.0):

- v2 `createCognitioServer` gains `env`, `inheritEnv`, `command`, and
  `shutdownTimeout`; new `stopAndWait` awaits child exit with SIGKILL
  escalation; `close()` is async and idempotent; every startup failure
  rejects only after the child settled. The legacy `src/server.ts` is
  intentionally untouched (upstream parity) and does not receive the new
  options. Regenerated schemas narrow the runtime-config preset union.

Scope note: hermetic spawn is config/persona/state isolation. It is NOT an
OS or tool sandbox — it does not restrict Bash/tools or file access
(permissions do that) and does not hide provider credentials from tool
subprocesses.

## 1.8.0 — Phase 10: Cost, Usage, Observability

- `session.usage`: live cost/usage accumulator (`{ turns, totalCostUsd, usage,
modelUsage }`, ResultMessage-aligned shapes). Folds observed own-session
  assistant updates idempotently and reconciles with each turn's authoritative
  `session.result`, so subagent child-session cost lands once without double
  counting. Attached/resumed handles start at zero; rewinds do not subtract.
- New normalized stream events: `rate_limit` plus `task.started`,
  `task.progress`, `task.notification` (`still_running` heartbeats), and
  `task.stopped` (`completed | error | interrupted`, `durationMs`). Task and
  rate-limit events are root-routed (`sessionId` = root, `activeSessionId` =
  originating session) so parent streams observe subagent activity; the SDK
  dedups duplicate start/terminal events, drops progress after the terminal,
  and applies stale-turn suppression.
- Server: `session.rate_limit_hit` Bus event (retryable rate limits from the
  retry path with `attempt`/`retryAfterSeconds`, non-retryable ones from the
  terminal failure path), task lifecycle events published from the tool-call
  lifecycle (`taskID` = tool call ID, payloads capped to short summaries —
  never raw commands/stdout), and a `still_running` heartbeat
  (`COGNITIO_TASK_HEARTBEAT_MS`, default 10s).
- Server OTel: metrics signal via Effect-native OTLP export (no new
  dependencies) — `cognitio.token.usage` (`type=output` includes reasoning),
  `cognitio.cost.usage`, `cognitio.session.count`, `cognitio.rate_limit.count`
  with delta temporality, `OTEL_METRIC_EXPORT_INTERVAL`, and opt-in
  `OTEL_METRICS_INCLUDE_SESSION_ID`; `gen_ai.usage.*` + `cognitio.usage.*` +
  `cognitio.cost_usd` span annotations per request on
  `SessionProcessor.process` and aggregated (plus `cognitio.num_turns`) on
  `SessionPrompt.run`; `OTEL_SERVICE_NAME`
  support; bounded telemetry flush on normal exit and SIGINT/SIGTERM (runtime
  registry disposal); AI SDK span prompt/completion content now redacted by
  default with `experimental.openTelemetryRecordInputs` / `...Outputs` opt-ins.
- Docs: new README Observability section (live usage, event taxonomy, OTel env
  passthrough in spawn mode, metric/cardinality reference, P12 allowlist note).
- Low-level SDK: regenerated `@cognitio/sdk/v2` with the five new events and
  config flags; bumped to `1.18.0`.
- Usage robustness: `session.usage` uses a bounded committed aggregate plus
  terminal sweeps. Manual and failed compaction, early stream exit, failed
  prompt/command POSTs, and result-less runs preserve observed partial spend
  without leaving permanent live entries; summary messages do not count as
  turns.
- Routing and event safety: forks created after the additive `session.fork_of`
  migration are lineage roots, while nested subagent provenance survives
  across streams and suppresses stale task/rate-limit/subagent activity even
  when the initial start event was missed. Task dedup keys include active
  session, part, and task IDs; late terminal activity is dropped. Retry delays
  clamp to the nonnegative schema, and task errors expose only short explicit
  message strings.
- Runtime integration: GitHub action exits, the TUI parent, and TUI workers
  use bounded runtime disposal so telemetry flushes before process/worker
  termination. Control-plane workspace forwarding includes service name,
  metric interval, session-cardinality, and temporality OTel variables.
- Tests: retry classification matrix (429-as-APIError fix), rate-limit event
  integration (retry + halt paths), task lifecycle (completed/error/interrupted,
  ordering, root-routing, heartbeat), metrics unit + result-consistency +
  teardown/SIGTERM flush e2e, subagent two-model and inherit-context aggregate
  regressions, exporter-level telemetry redaction/opt-in coverage,
  `OTEL_SERVICE_NAME` resource tests,
  SDK normalization/dedup, `session.usage` live+reconcile+compaction+sweep
  suites, stale-subagent task AND rate-limit suppression, composite dedup
  scoping, resume-zero baseline, negative retry-after clamps, cost-metric
  consistency, progress throttle + title truncation, and error-object
  sanitization.

## 1.7.0 — Phase 9: Structured Output Retry

- Structured output: added `defineOutputFormat(schema, { maxRetries })`,
  `RuntimeConfig.outputFormat`, and the `OutputOf<typeof format>` helper type.
- Retry mapping: SDK `maxRetries` serializes to server `retryCount`; the
  accepted runtime output format is also sent with `prompt_async`.
- Results: `send()` / `stream()` surface `structuredOutput` and terminal
  `error_max_structured_output_retries` results from the server.
- Server behavior: structured-output repair attempts are real model calls,
  count toward turns, cost, budget, and `maxTurns`, and retry feedback is
  ephemeral to the next model request.
- Low-level SDK: regenerated `@cognitio/sdk/v2` for
  `RuntimeConfig.outputFormat.retryCount` and the new result subtype, and
  bumped to `1.17.0`.
- Tests: server retry/exhaustion/maxTurns coverage, Agent SDK runtime-format
  serialization and result surfacing, generated SDK type coverage, and package
  typechecks.

## 1.6.0 — Phase 8: Skills, Slash Commands, and Plugins

- Runtime skills and commands: `RuntimeConfig.skills` and `commands` now
  accept session-scoped definitions, including model/tool metadata and
  command-level tool policy narrowing.
- Plugins: `RuntimeConfig.plugins` supports inline plugin bundles and local
  Claude-compatible plugin paths via `claudeCompat(path)`, with namespaced
  skills, commands, agents, compatible hooks, compatible runtime MCP servers,
  substitution variables, and diagnostics for unsupported Claude features.
- Slash commands: added `Session.command(name, args?, options?)`, backed by
  the existing command route and the same streamed terminal `ResultMessage`
  behavior as `send()`.
- Snapshot safety: server slash-command execution now uses the accepted
  runtime-config snapshot for lookup, templates, model/agent selection, hints,
  and nested prompt execution instead of rereading live runtime config.
- Cleanup: `Session.close()` now removes SDK-owned direct MCP descriptors from
  root/child sessions and clears scoped accepted-runtime MCP clients before
  local dispatchers are stopped.
- Helper APIs: exported `defineSkill()`, `defineCommand()`, `definePlugin()`,
  and `claudeCompat()`.
- Introspection: session runtime-config effective settings now include skill,
  command, and plugin summaries, and the low-level SDK exposes session-aware
  command/skill listing routes.
- Low-level SDK: regenerated `@cognitio/sdk/v2` for Phase 8 runtime config
  schemas, effective summaries, and session command/skill list routes, and
  bumped to `1.16.0`.
- Tests: server runtime skill/command/plugin materialization, Claude plugin
  fixture loading, command snapshot regression, session-aware lists, Agent SDK
  helper/session.command coverage, and package typechecks.

## 1.5.0 — Phase 7: Sessions, Checkpoints, Todos, Transcript Fidelity

- Session management: added `sessions.list(filter)`, `resume()`,
  `continue({ cwd })`, `fork()`, `delete()`, `Session.rename()`, `tag()`, and
  `untag()`, with cwd/workspace routing preserved for existing handles.
- Tags: server sessions now store normalized tags, `PATCH /session/:id` accepts
  `tags`, and local/global list routes support exact tag filters.
- Checkpoints: added checkpoint records, `POST /session/:id/checkpoint`,
  `GET /session/:id/checkpoints`, `POST /session/:id/rewind`, SDK
  `checkpoint()`, `listCheckpoints()`, and `rewind()`.
- File checkpointing: `RuntimeConfig.enableFileCheckpointing` enables
  edit-family auto-checkpoints after successful post-tool hooks; Bash remains
  excluded.
- Todos and transcript fidelity: added `getTodos()`, live `todos()` snapshots,
  normalized todo/checkpoint/rewind stream events, and `messages()` backed by
  active transcript retrieval.
- Low-level SDK: regenerated `@cognitio/sdk/v2` for checkpoint routes,
  session tags, active message view, checkpoint/rewind events, todo events, and
  `enableFileCheckpointing`, and bumped to `1.15.0`.
- Phase 7B closeout: checkpoint backing snapshots are pinned in the internal
  Git snapshot store before persistence/rewind, rewind preflights missing or
  corrupt snapshots before mutating files, stale tracked OpenAPI artifacts were
  refreshed, and generated SDK coverage now asserts tag/update/message view and
  checkpoint/rewind/todo event contracts.
- Tests: checkpoint rewind/fork coverage, session tag and active transcript
  route tests, Agent SDK protocol smoke coverage for session management,
  todos, checkpoints, rewind, messages, and event normalization.

## 1.4.0 — Phase 6: system prompt composition and compaction hooks

- Runtime prompts: `RuntimeConfig.systemPrompt`, `appendSystemPrompt`, and
  `settingSources` now pass through to the server and are exposed through
  `getAppliedSettings()` as redacted effective metadata.
- System composition: custom prompt strings replace the agent base prompt;
  preset prompts keep the cognitio/provider default unless `preset:"none"` is
  requested; append strings are added after call-level/user system text.
- Instruction sources: sessions can disable or narrow user/project/local
  instruction loading without affecting read-time nearby instruction discovery.
- Compaction hooks: `PreCompact` hook callbacks can return
  `customInstructions`, with multiple callbacks joined by blank lines before
  summarization. `PostCompact` receives enriched observer payloads.
- Manual compaction: added `Session.compact({ model? })`, which subscribes
  before posting summarize and returns enriched boundary metadata:
  `compactionId`, `preCompactTokenCount`, and `preservedMessageIds`.
- Stream events: `system.compact_boundary` is normalized with optional
  `trigger`, `preCompactTokenCount`, `compactionId`, and
  `preservedMessageIds` fields.
- Low-level SDK: regenerated `@cognitio/sdk/v2` for enriched compact
  boundary events and summarize `customInstructions`, and bumped to `1.14.25`.
- Tests: server prompt/instruction/compaction coverage, Agent SDK compact and
  hook aggregation smoke tests, generated SDK type tests, and package
  typechecks.

## 1.3.0 — Phase 5: session-scoped agents and subagents

- Runtime agents: `RuntimeConfig.agents` now accepts typed, validated,
  session-scoped definitions with prompt, description, model, tool allow/deny
  rules, permission mode, remote MCP specs, step limit, temperature, and
  `spawnMode`.
- Resolution order: runtime agents override file-based and built-in agents for
  the current session only, without writing `.cognitio/agent` files.
- Subagents: the task tool supports `spawnMode: "fresh" | "inherit"`,
  stores a derived child runtime snapshot, keeps agent models/policies inside
  child sessions, and copies inherited context with safe filtering,
  pre-compaction guarding, and zero-cost cloned assistant history.
- Direct SDK MCP: `createSdkMcpServer({ transport: "direct" })` registers
  SDK-local tools without loopback HTTP and routes child subagent calls through
  the root SDK control channel.
- Observability: explicit `subagent.start`, `subagent.progress`, and
  `subagent.stop` stream events are normalized by the SDK.
- Helper APIs: exported `defineAgent()`, added `Session.setAgents()`, and
  extended `getAppliedSettings().agents`.
- Run-loop hardening: server prompt ordering no longer depends on
  lexicographic message IDs for same-session multi-turn SDK calls.
- Low-level SDK: regenerated `@cognitio/sdk/v2` for runtime agents,
  `spawnMode`, direct SDK MCP descriptors, and subagent events and bumped to
  `1.14.24`.
- Tests: server runtime-config/task-tool coverage, Agent SDK agent
  normalization tests, generated SDK runtime-config type checks, and Phase 5
  package typechecks.

## 1.2.0 — Phase 4: permissions and hooks

- Permission modes: runtime `permissionMode` now participates in server-side
  permission evaluation for `default`, `acceptEdits`, `dontAsk`, `plan`,
  `bypassPermissions`, and deterministic `auto` mode.
- Staged safety: explicit server/runtime deny cannot be bypassed by SDK
  callbacks, and `canUseTool` only joins after rules and modes decide a tool
  call is still askable. Permission-updated built-in and direct-subtask inputs
  are re-authorized before execution.
- Ask-channel callbacks: `RuntimeConfig.canUseTool` is serialized as a local
  SDK capability, invoked through the control channel, deduped by request ID,
  and raced against the existing user permission prompt.
- Hooks: runtime hook descriptors, matcher metadata, timeout fields, async
  fire-and-forget hooks, `defineHook()` options, and dispatcher aggregation are
  enabled for the 15 Phase 4 Agent SDK hook events.
- Hook results: SDK callbacks can deny, stop, ask, update tool input, update
  tool output, or add context through the structured `HookResult` shape.
- Auto classifier: server `auto` mode has a provider-backed structured
  classifier boundary, 5-minute caching, configurable model selection, safe ask
  fallback on errors, and deterministic fake-provider tests.
- Effective settings: runtime-config introspection now reports Phase 4
  permission mode, `canUseTool` registration, hook counts, and classifier
  model summaries.
- Helper APIs: exported `PermissionDecision.allow()`, `.deny()`, and `.ask()`,
  plus `Session.setPermissionMode()` and Phase 4 `getAppliedSettings()` fields.
- Low-level SDK: regenerated `@cognitio/sdk/v2` for the additive runtime
  config and control-channel contracts and bumped to `1.14.23`.
- Tests: server runtime config, permission pipeline precedence and ask race,
  auto classifier behavior, Agent SDK runtime normalization, dispatcher
  callback execution, generated SDK types, and full Agent SDK smoke coverage.

## 1.1.0 — Phase 3: tools

- Server tool policy: `RuntimeConfig.allowedTools` and `disallowedTools`
  now normalize SDK-facing names, internal tool IDs, generated MCP tool IDs,
  and scoped rules such as `Bash(npm:*)`; a non-empty allow list is strict,
  and deny rules win.
- Enforcement: runtime tool policy is applied to model-facing tool schemas and
  to the permission ask path, including MCP tools. Edit-family file resource
  review still uses cognitio's existing `edit` permission domain, while
  runtime whole-tool allow/deny stays exact by mapping shared-domain asks back
  to the current tool ID when applicable.
- Introspection: runtime-config effective settings now include normalized
  `tools.allowed` and `tools.disallowed`.
- SDK MCP: `defineTool()` custom tools can be hosted as session-owned loopback
  MCP servers via `createSdkMcpServer()`. Local SDK-hosted MCP is spawn/local
  only; remote clients can pass externally reachable remote MCP specs instead.
  SDK-hosted MCP is tools-only in Phase 3A; non-empty `resources` or
  `prompts` arrays are rejected until a later phase supports them.
- Runtime MCP: cognitio can attach session-scoped remote MCP specs without
  mutating instance-global MCP config, and runtime MCP clients are cleared on
  runtime-config empty-list/clear, SDK `Session.close()`, and session removal.
- Tool search: new server built-in `tool_search` defers MCP/custom tool
  schemas when enabled, searches deferred descriptors, and exposes selected
  tool schemas on later steps in the same run. Strict allowlists keep
  `tool_search` visible when it is the only route to allowed deferred tools,
  while explicit `disallowedTools: ["tool_search"]` remains absolute.
- Permission and validation hardening: malformed `allowedTools` /
  `disallowedTools` strings now fail runtime-config writes atomically; runtime
  deny rules override persisted "always" approvals on permission asks; unknown
  generated MCP IDs preserve case while built-in aliases remain
  case-insensitive; unmatched closing parentheses are rejected.
- Tool metadata: MCP `_meta` search hints / always-load hints and annotations
  are preserved into tool-search descriptors, SDK-defined tools can emit those
  hints through `ToolDefinition.metadata`, and `alwaysLoad` prevents deferral.
- Tool definitions: `ToolDefinition` now accepts JSON-schema-only tools via
  `inputJsonSchema` without requiring an `inputSchema` cast, validates JSON
  object schemas before hosting, and serializes void tool results as empty MCP
  text.
- Agent SDK runtime config: Phase 3 fields no longer fail fast:
  `allowedTools`, `disallowedTools`, `sdkMcpServers`, and
  `enableToolSearch`. Future Phase 4+ fields still failed fast in this
  release.
- Low-level SDK: regenerated `@cognitio/sdk/v2` for the additive
  runtime-config `effective.tools` contract and bumped to `1.14.22`.
- Tests: server rule parsing, runtime policy, prompt tool exposure,
  permission propagation, tool search, runtime MCP lifecycle, Agent SDK MCP
  hosting, remote MCP pass-through, and generated SDK runtime-config coverage.

## 1.0.0 — Phase 2: core session loop

- Server runtime: `session.result` now includes `error_max_turns` and
  `error_max_budget`; the prompt loop snapshots runtime config per run,
  enforces `model`, `maxTurns`, and `maxBudgetUsd`, treats `agent.steps` as
  a hard cap via `min(runtime.maxTurns, agent.steps)`, checks budget at
  exact equality, and preserves hard-stop result precedence over late
  abort/error races.
- Runtime-config view: `GET /session/:id/runtime-config` now reports Phase 2
  effective fields only (`model`, `maxTurns`, `maxBudgetUsd`) with default,
  agent, and runtime model resolution and maxTurns min behavior, without
  claiming tool, permission, hook, agent, MCP, or output-format enforcement.
- Human review closeout approved Phase 2. The final implementation includes
  prompt-acceptance runtime snapshot isolation, `agent.steps` hard-cap
  behavior, exact budget-equality stops, missing-`session.result` idle
  failure, richer result payload forwarding, reasoning/raw event
  normalization, control-event suppression from per-call streams, and
  `interrupt(): Promise<void>` contract alignment. Remaining lifecycle polish
  was moved to later phase follow-ups in the implementation plan.
- Low-level SDK: regenerated `@cognitio/sdk/v2` and bumped to `1.14.21`
  for the additive `session.result` subtype union.
- Agent SDK: `send()` returns the terminal `ResultMessage`; `stream()` returns
  `AsyncGenerator<AgentMessage, ResultMessage>`, terminates on
  `session.result`, fails promptly if same-session `session.idle` arrives
  first, normalizes user/assistant/partial/tool/result/reasoning events, yields
  unknown same-session events as `raw`, and keeps control-channel events
  dispatcher-only.
- Result payload: `ResultMessage` now preserves `messageId`,
  `parentMessageId`, `stopReason`, `usage`, `modelUsage`, `structuredOutput`,
  and terminal `error.message` from `session.result`.
- Interrupt: `interrupt(): Promise<void>` posts server abort. Active
  `send()` / `stream()` calls resolve from the terminal result path, including
  `error_aborted`; calling it with no active query just posts abort.
- Prompt input: string, `{ text }`, `{ parts }`, file/image parts, and
  sequential async turns serialize through server prompt input parts.
- Runtime config API: create-time config validates atomically for supported
  fields, `setModel("provider/model")` patches runtime config, and
  `getAppliedSettings()` round-trips Phase 2 effective settings.
- Safety: one active `send()` / `stream()` per `Session`; early stream break
  releases the SDK guard and closes only the per-call SSE subscription.
- Close-out hardening: terminal `session.result` ownership is tied to the
  active prompt `parentMessageID`, async prompt iterators are closed on early
  stream exit, task-child LLM turns participate in run-wide `maxTurns`, and
  budget checks cover already-persisted current-run cost before natural
  success. The spawned fake server fixture now includes `parentMessageID` on
  Phase 2 terminal results.
- Latest close-out polish: direct-subtask wrapper messages are excluded from model-turn
  accounting, task children receive remaining parent turn/budget limits, stale
  SDK result suppression has a bounded idle grace window, and early stream-break
  cleanup releases local SDK resources before best-effort server abort.
- Tests: server model/turn/budget enforcement, runtime-config effective view,
  generated SDK runtime-config smoke, normalized stream/send behavior, prompt
  parts, active-query overlap, fake spawn parity, and result ordering
  regressions.

## 0.0.2 — Phase 1B: transport and control channel

- Server control routes: added `POST /session/:id/control-response`,
  `POST /session/:id/control-cancel`, and
  `GET /session/:id/control-requests` with session/subtype guards,
  strict required OpenAPI body refs, and immutable list snapshots.
- Low-level SDK: regenerated `@cognitio/sdk/v2` so
  `client.session.controlChannel.{response,cancel,list}` is typed, with
  required `controlResponseBody` / `controlCancelBody` request wrappers.
- Agent SDK dispatcher: each session handle starts a dedicated control SSE
  subscription, filters to its session, dedupes request IDs, recovers
  pending requests after reconnect, and posts Phase 1B fallback responses.
- Lifecycle: one live session handle is reused per `sessionId`;
  `Session.close()` awaitably stops and unregisters its dispatcher; and
  `AgentClient.close()` closes active session handles before closing the
  transport.
- Reconnect/cancellation: cancel-before-request is remembered for replay
  dedupe, the completed-ID set is intentionally bounded, reconnect attempts
  after readiness respect `maxAttempts`, and `/control-requests` recovery
  failures count against the retry budget.
- Tests: cognitio registry/routes, generated SDK control-channel smoke, and
  agent-sdk dispatcher roundtrips, cancellation, reconnect, readiness
  timeout, close, fallback, and cleanup coverage.

## 0.0.1 — Phase 1A: server substrate

- Server substrate: session-scoped `RuntimeConfig` store plus
  `GET/PATCH/DELETE /session/:id/runtime-config` routes. This is CRUD only;
  enforcement stays in later phases.
- Control channel substrate: `ControlRequestRegistry` plus
  `control.request` / `control.cancelled` event envelopes.
- Lifecycle events: explicit `session.result` and
  `system.compact_boundary` contracts; `session.idle` remains for backwards
  compatibility.
- Transcript fidelity: additive `parentMessageID` on user/assistant
  messages, user-message pre-persist before resolution, and
  `Session.Info.revert.checkpointId` as a public alias of `snapshot`.

## 0.0.0 — scaffold

- Phase 0: package skeleton, public API surface, type contracts, thin
  delegating facade over `@cognitio/sdk/v2`, smoke tests.
- Stream: real-time SSE delivery, per-`sessionID` filtering,
  `session.idle` termination, `promptAsync` submission, and
  `AbortController`-based cleanup on early consumer break.
- Session: per-session cwd routing is preserved across `create` / `get` /
  `list` / `fork` / `resume`, and `fork()` now inherits the source
  session's cwd instead of the client default directory.
- Tools: `createSdkMcpServer` includes the Phase 0 shape for `tools`,
  `resources`, and `prompts`; Phase 3A serves tools and explicitly rejects
  non-empty `resources` / `prompts` until later support lands. `defineHook`
  supports tool hooks with or without a matcher.
- Errors: shared `assertOk` / `assertNoError` helpers surface the
  low-level SDK's `{ error }` branch across `create` / `get` / `list` /
  `fork` / `send` / `abort` / `stream`.
- Contracts: non-empty `runtimeConfig` now fails fast with a phase-specific
  `not implemented yet` error, and streamed `PromptInput.parts` reject until
  Phase 2 instead of being silently ignored.
- Stubs: unimplemented async methods reject (instead of throwing
  synchronously); `todos()` is an async generator.
- Build: `main` / `types` / `exports` point to `./dist` and `prepare`
  runs `tsc` so in-repo consumers always have compiled output available.
- Tests: mock-server protocol smoke (real-time, sessionID filter, cwd
  propagation, `get()` / `fork()` cwd continuity, error surfacing, SSE
  cleanup on early break); the test harness now reserves explicit free ports
  instead of relying on `port: 0` under Bun 1.3.11; spawn smoke for end-to-end
  create → send → stream → list → close through both a deterministic
  fake CLI and the real cognitio binary when available.
