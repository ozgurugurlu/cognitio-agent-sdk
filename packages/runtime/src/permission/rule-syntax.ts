const TOOL_ALIASES: Record<string, string> = {
  read: "read",
  edit: "edit",
  write: "write",
  bash: "bash",
  glob: "glob",
  grep: "grep",
  webfetch: "webfetch",
  fetch: "webfetch",
  websearch: "websearch",
  search: "websearch",
  codesearch: "codesearch",
  code: "codesearch",
  todowrite: "todowrite",
  todo: "todowrite",
  task: "task",
  skill: "skill",
  applypatch: "apply_patch",
  apply_patch: "apply_patch",
  patch: "apply_patch",
  question: "question",
  lsp: "lsp",
  planexit: "plan_exit",
  plan_exit: "plan_exit",
  toolsearch: "tool_search",
  tool_search: "tool_search",
  invalid: "invalid",
}

export interface ToolRuleSyntax {
  raw: string
  tool: string
  pattern?: string
}

function readUntil(input: string, start: number, stop: string) {
  let value = ""
  for (let i = start; i < input.length; i++) {
    const char = input[i]
    if (char === "\\") {
      if (i + 1 >= input.length) {
        value += char
        continue
      }
      value += input[i + 1]
      i++
      continue
    }
    if (char === stop) return { value, index: i }
    value += char
  }
  return { value, index: -1 }
}

function hasUnescaped(input: string, value: string) {
  for (let i = 0; i < input.length; i++) {
    if (input[i] === "\\") {
      i++
      continue
    }
    if (input[i] === value) return true
  }
  return false
}

export function normalizeToolName(input: string) {
  const trimmed = input.trim()
  if (!trimmed) throw new Error("Tool rule must include a tool name")
  const lower = trimmed.toLowerCase()
  if (TOOL_ALIASES[lower]) return TOOL_ALIASES[lower]
  if (/[-_\s]/.test(trimmed)) return trimmed
  return TOOL_ALIASES[lower] ?? trimmed
}

export function parse(input: string): ToolRuleSyntax {
  if (typeof input !== "string") throw new Error("Tool rule must be a string")
  const raw = input.trim()
  if (!raw) throw new Error("Tool rule must not be empty")
  const head = readUntil(raw, 0, "(")
  if (head.index === -1) {
    if (hasUnescaped(raw, ")")) throw new Error(`Malformed tool rule "${input}": unmatched closing parenthesis`)
    return { raw, tool: normalizeToolName(head.value) }
  }
  if (hasUnescaped(raw.slice(0, head.index), ")")) {
    throw new Error(`Malformed tool rule "${input}": unmatched closing parenthesis`)
  }

  const tail = readUntil(raw, head.index + 1, ")")
  if (tail.index === -1) throw new Error(`Malformed tool rule "${input}": missing closing parenthesis`)
  if (raw.slice(tail.index + 1).trim()) {
    throw new Error(`Malformed tool rule "${input}": unexpected text after closing parenthesis`)
  }

  const tool = normalizeToolName(head.value)
  const pattern =
    tool === "bash" ? normalizeBashPattern(tail.value.trim()) : normalizePattern(tail.value.trim())
  return { raw, tool, pattern }
}

export function format(input: ToolRuleSyntax) {
  if (input.pattern === undefined || input.pattern === "*") return escapeRuleSegment(input.tool)
  return `${escapeRuleSegment(input.tool)}(${escapeRuleSegment(input.pattern)})`
}

function normalizePattern(pattern: string) {
  if (!pattern || pattern === "*") return "*"
  return pattern
}

function normalizeBashPattern(pattern: string) {
  const normalized = normalizePattern(pattern)
  if (normalized === "*") return normalized
  return normalized.replace(/:/g, " ")
}

function escapeRuleSegment(input: string) {
  return input.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
}

export * as PermissionRuleSyntax from "./rule-syntax"
