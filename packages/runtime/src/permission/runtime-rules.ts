import { Wildcard } from "@/util"
import type { RuntimeConfig } from "@/session/runtime-config"
import type { Permission } from "."
import { PermissionRuleSyntax } from "./rule-syntax"

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit"])

export interface RuntimeToolPolicy {
  allowed: string[]
  disallowed: string[]
  toolRuleset: Permission.Ruleset
  ruleset: Permission.Ruleset
  isVisible(tool: string): boolean
  allows(tool: string): boolean
  denies(tool: string): boolean
  isExplicitlyDenied(tool: string): boolean
  permissionForAsk(tool: string, permission: string): string
}

function permissionForTool(tool: string) {
  return EDIT_TOOLS.has(tool) ? "edit" : tool
}

function rule(input: PermissionRuleSyntax.ToolRuleSyntax, action: Permission.Action): Permission.Rule {
  return {
    permission: input.tool,
    pattern: input.pattern ?? "*",
    action,
  }
}

function matchesTool(input: PermissionRuleSyntax.ToolRuleSyntax, tool: string) {
  return Wildcard.match(tool, input.tool)
}

function isToolWide(input: PermissionRuleSyntax.ToolRuleSyntax) {
  return input.pattern === undefined || input.pattern === "*"
}

export function fromConfig(runtime: Pick<RuntimeConfig, "allowedTools" | "disallowedTools">): RuntimeToolPolicy {
  const allowedRules = (runtime.allowedTools ?? []).map(PermissionRuleSyntax.parse)
  const disallowedRules = (runtime.disallowedTools ?? []).map(PermissionRuleSyntax.parse)
  const strict = allowedRules.length > 0
  const ruleset: Permission.Ruleset = [
    ...(strict ? [{ permission: "*", pattern: "*", action: "deny" as const }] : []),
    ...allowedRules.map((item) => rule(item, "allow")),
    ...disallowedRules.map((item) => rule(item, "deny")),
  ]
  const toolRuleset: Permission.Ruleset = [
    ...(strict ? [{ permission: "*", pattern: "*", action: "deny" as const }] : []),
    ...allowedRules.map((item) => rule(item, "allow")),
    ...disallowedRules.map((item) => rule(item, "deny")),
  ]

  const isExplicitlyDenied = (tool: string) =>
    disallowedRules.some((item) => matchesTool(item, tool) && isToolWide(item))
  const allows = (tool: string) => !strict || allowedRules.some((item) => matchesTool(item, tool))
  const denies = (tool: string) => isExplicitlyDenied(tool)

  return {
    allowed: allowedRules.map(PermissionRuleSyntax.format),
    disallowed: disallowedRules.map(PermissionRuleSyntax.format),
    toolRuleset,
    ruleset,
    allows,
    denies,
    isExplicitlyDenied,
    permissionForAsk(tool, permission) {
      return permissionForTool(tool) === permission ? tool : permission
    },
    isVisible(tool) {
      if (denies(tool)) return false
      return allows(tool)
    },
  }
}

export * as RuntimeToolRules from "./runtime-rules"
