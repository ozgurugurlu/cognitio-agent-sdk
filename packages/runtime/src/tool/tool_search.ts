import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"

const Parameters = z.object({
  query: z.string().describe("Search query for deferred tools. Use select:tool_a,tool_b to reveal exact tools."),
  max_results: z.number().int().positive().max(20).optional().describe("Maximum number of matching tools to return."),
})

export interface DeferredTool {
  id: string
  description: string
  schema: unknown
  searchHint?: string
  capabilityFlags?: Tool.SearchMetadata["capabilityFlags"]
  source?: Tool.SearchMetadata["source"]
}

interface ToolSearchContext {
  deferred: DeferredTool[]
  selected: Set<string>
}

interface ToolSearchMetadata {
  matches: Array<{
    name: string
    description: string
    source?: Tool.SearchMetadata["source"]
    capability_flags?: Tool.SearchMetadata["capabilityFlags"]
    input_schema: unknown
  }>
  query: string
  total_deferred_tools: number
}

function context(input: unknown): ToolSearchContext | undefined {
  if (!input || typeof input !== "object") return
  const value = (input as { toolSearch?: unknown }).toolSearch
  if (!value || typeof value !== "object") return
  const candidate = value as { deferred?: unknown; selected?: unknown }
  if (!Array.isArray(candidate.deferred) || !(candidate.selected instanceof Set)) return
  return candidate as ToolSearchContext
}

function terms(query: string) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function selected(query: string) {
  const match = query.match(/(?:^|\s)select:([^\s]+)/i)
  if (!match) return []
  return match[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

export function search(input: { query: string; deferred: DeferredTool[]; maxResults?: number }) {
  const direct = selected(input.query)
  const matches = direct.length
    ? input.deferred.filter((tool) => direct.includes(tool.id))
    : input.deferred
        .map((tool) => ({ tool, score: score(tool, input.query) }))
        .filter((item) => item.score > 0)
        .toSorted((a, b) => b.score - a.score || a.tool.id.localeCompare(b.tool.id))
        .map((item) => item.tool)
  return matches.slice(0, input.maxResults ?? 10)
}

function score(tool: DeferredTool, query: string) {
  const haystack = [tool.id, tool.description, tool.searchHint].filter(Boolean).join(" ").toLowerCase()
  const queryTerms = terms(query).filter((term) => !term.startsWith("select:"))
  const required = queryTerms.filter((term) => term.startsWith("+")).map((term) => term.slice(1))
  if (required.some((term) => !haystack.includes(term))) return 0
  const normal = queryTerms.filter((term) => !term.startsWith("+"))
  const id = tool.id.toLowerCase()
  return normal.reduce((total, term) => {
    if (id === term) return total + 100
    if (id.startsWith(term)) return total + 50
    if (id.split(/[_-]/).includes(term)) return total + 25
    if (haystack.includes(term)) return total + 10
    return total
  }, required.length ? required.length * 15 : 0)
}

export const ToolSearchTool = Tool.define<typeof Parameters, ToolSearchMetadata, never>(
  "tool_search",
  Effect.succeed({
    description: [
      "Search deferred tools and reveal selected tool schemas for later steps.",
      "Use a natural language query for ranked results, +term for required terms, or select:tool_a,tool_b for exact selection.",
    ].join("\n"),
    parameters: Parameters,
    metadata: {
      alwaysLoad: true,
      source: "builtin" as const,
    },
    execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
      Effect.sync(() => {
        const state = context(ctx.extra)
        if (!state) {
          return {
            title: "Tool search unavailable",
            metadata: { matches: [], query: params.query, total_deferred_tools: 0 },
            output: JSON.stringify({ matches: [], query: params.query, total_deferred_tools: 0 }, null, 2),
          }
        }

        const limited = search({ query: params.query, deferred: state.deferred, maxResults: params.max_results })
        for (const tool of limited) state.selected.add(tool.id)

        const payload = {
          matches: limited.map((tool) => ({
            name: tool.id,
            description: tool.description,
            source: tool.source,
            capability_flags: tool.capabilityFlags,
            input_schema: tool.schema,
          })),
          query: params.query,
          total_deferred_tools: state.deferred.length,
        }

        return {
          title: `Found ${limited.length} deferred tool${limited.length === 1 ? "" : "s"}`,
          metadata: payload,
          output: JSON.stringify(payload, null, 2),
        }
      }),
  }),
)
