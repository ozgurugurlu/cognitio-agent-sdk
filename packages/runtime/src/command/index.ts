import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect"
import { EffectBridge } from "@/effect"
import type { InstanceContext } from "@/project/instance"
import { SessionID, MessageID } from "@/session/schema"
import { Effect, Layer, Context } from "effect"
import z from "zod"
import { Config } from "../config"
import { ConfigResources } from "@/config/resources"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"

type State = {
  builtins: Record<string, Info>
  mcp: Record<string, Info>
}

export const Event = {
  Executed: BusEvent.define(
    "command.executed",
    z.object({
      name: z.string(),
      sessionID: SessionID.zod,
      arguments: z.string(),
      messageID: MessageID.zod,
    }),
  ),
}

export const Info = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    source: z.enum(["command", "mcp", "skill"]).optional(),
    origin: z.enum(["builtin", "config", "mcp", "skill", "runtime", "plugin"]).optional(),
    pluginName: z.string().optional(),
    pluginRoot: z.string().optional(),
    skillDir: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    // workaround for zod not supporting async functions natively so we use getters
    // https://zod.dev/v4/changelog?id=zfunction
    template: z.promise(z.string()).or(z.string()),
    subtask: z.boolean().optional(),
    hints: z.array(z.string()),
  })
  .meta({
    ref: "Command",
  })

// for some reason zod is inferring `string` for z.promise(z.string()).or(z.string()) so we have to manually override it
export type Info = Omit<z.infer<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
} as const

export interface Interface {
  readonly get: (name: string, sources?: readonly ConfigResources.Gate[]) => Effect.Effect<Info | undefined>
  readonly list: (sources?: readonly ConfigResources.Gate[]) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@cognitio/Command") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const bridge = yield* EffectBridge.make()
      const builtins: Record<string, Info> = {}

      builtins[Default.INIT] = {
        name: Default.INIT,
          description: "guided AGENTS.md setup",
          source: "command",
          origin: "builtin",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      builtins[Default.REVIEW] = {
        name: Default.REVIEW,
          description: "review changes [commit|branch|pr], defaults to uncommitted",
          source: "command",
          origin: "builtin",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }

      const mcpCommands: Record<string, Info> = {}
      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        mcpCommands[name] = {
          name,
          source: "mcp",
          origin: "mcp",
          description: prompt.description,
          get template() {
            return bridge.promise(
              mcp
                .getPrompt(
                  prompt.client,
                  prompt.name,
                  prompt.arguments
                    ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                    : {},
                )
                .pipe(
                  Effect.map(
                    (template) =>
                      template?.messages
                        .map((message) => (message.content.type === "text" ? message.content.text : ""))
                        .join("\n") || "",
                  ),
                ),
            )
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }

      return { builtins, mcp: mcpCommands }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    // Assembled per call in today's construction order (builtins → config file
    // defs → MCP always-wins → skills only-if-absent). Existing Info objects
    // are kept by reference: MCP templates are lazy accessors that fire a
    // network request when read, so they must never be spread/copied.
    const view = Effect.fn("Command.view")(function* (sources?: readonly ConfigResources.Gate[]) {
      const s = yield* InstanceState.get(state)
      const resources = yield* config.resources()
      const commands: Record<string, Info> = {}

      for (const [name, info] of Object.entries(s.builtins)) commands[name] = info

      for (const [name, command] of ConfigResources.fold(resources.command, sources)) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          origin: "config",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      for (const [name, info] of Object.entries(s.mcp)) commands[name] = info

      for (const item of yield* skill.all(sources)) {
        if (commands[item.name]) continue
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          origin: "skill",
          get template() {
            return item.content
          },
          hints: [],
        }
      }

      return commands
    })

    const get = Effect.fn("Command.get")(function* (name: string, sources?: readonly ConfigResources.Gate[]) {
      return (yield* view(sources))[name]
    })

    const list = Effect.fn("Command.list")(function* (sources?: readonly ConfigResources.Gate[]) {
      return Object.values(yield* view(sources))
    })

    return Service.of({ get, list })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(MCP.defaultLayer),
  Layer.provide(Skill.defaultLayer),
)

export * as Command from "."
