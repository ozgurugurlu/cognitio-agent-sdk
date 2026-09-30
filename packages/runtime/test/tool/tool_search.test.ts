import { describe, expect, test } from "bun:test"
import { search, type DeferredTool } from "../../src/tool/tool_search"

const tools: DeferredTool[] = [
  {
    id: "weather_get_forecast",
    description: "Return a weather forecast for a city",
    schema: { type: "object" },
    source: "mcp",
  },
  {
    id: "notes_search",
    description: "Search private notes and documents",
    schema: { type: "object" },
    source: "mcp",
  },
  {
    id: "calendar_create_event",
    description: "Create an event",
    schema: { type: "object" },
    searchHint: "meeting schedule",
    source: "mcp",
  },
]

describe("tool_search ranking", () => {
  test("exact and prefix name matches beat description matches", () => {
    expect(search({ query: "weather", deferred: tools }).map((tool) => tool.id)).toEqual([
      "weather_get_forecast",
    ])
    expect(search({ query: "search", deferred: tools }).map((tool) => tool.id)[0]).toBe("notes_search")
  })

  test("select chooses exact tool IDs", () => {
    expect(search({ query: "select:calendar_create_event,missing", deferred: tools })).toEqual([tools[2]])
  })

  test("+required terms filter candidates", () => {
    expect(search({ query: "+private weather", deferred: tools }).map((tool) => tool.id)).toEqual(["notes_search"])
  })

  test("maxResults limits matches", () => {
    expect(search({ query: "event search weather", deferred: tools, maxResults: 2 })).toHaveLength(2)
  })
})
