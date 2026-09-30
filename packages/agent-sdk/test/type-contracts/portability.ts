import type {
  AgentOptions,
  RuntimeConfig,
  SessionCreateOptions,
  LocalMcpServer,
  RemoteMcpServer,
  ThinkingConfig,
  CheckpointingConfig,
  SdkError,
} from "../../src/index.js"

type Assert<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Forbidden = Map<unknown, unknown> | Set<unknown> | Date
type Portable<T> = T extends Forbidden
  ? false
  : T extends (...args: never[]) => unknown
    ? true
    : T extends object
      ? false extends { [K in keyof T]-?: Portable<T[K]> }[keyof T]
        ? false
        : true
      : true

type _RuntimeScalars = Assert<
  Portable<
    Pick<
      RuntimeConfig,
      | "model"
      | "effort"
      | "thinkingConfig"
      | "maxTurns"
      | "maxBudgetUsd"
      | "settingSources"
      | "checkpointing"
      | "compaction"
      | "backgroundTaskPolicy"
      | "includeEnvironment"
    >
  >
>
type _ExternalMcp = Assert<Portable<LocalMcpServer | RemoteMcpServer>>
type _Policies = Assert<Portable<ThinkingConfig | CheckpointingConfig>>
type _FlatFacade = Assert<Equal<AgentOptions["model"], RuntimeConfig["model"]>>
type _CreateConfig = Assert<Equal<SessionCreateOptions["runtimeConfig"], RuntimeConfig | undefined>>
type _ErrorTag = Assert<Equal<SdkError["name"], "CognitioSdkError">>

// Callbacks are intentionally local objects; their wire representation is an
// opaque descriptor. Serializable public policy fields cannot acquire Map,
// Set, Date, or an exported error subclass by accident.
