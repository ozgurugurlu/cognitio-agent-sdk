import { describe, expect, test } from "bun:test"
import { PermissionRuleSyntax } from "../../src/permission/rule-syntax"

describe("permission rule syntax", () => {
  test("normalizes bare built-in tool names", () => {
    expect(PermissionRuleSyntax.parse("Read")).toEqual({ raw: "Read", tool: "read" })
    expect(PermissionRuleSyntax.parse("WebFetch")).toEqual({ raw: "WebFetch", tool: "webfetch" })
    expect(PermissionRuleSyntax.parse("fetch")).toEqual({ raw: "fetch", tool: "webfetch" })
    expect(PermissionRuleSyntax.parse("ApplyPatch")).toEqual({ raw: "ApplyPatch", tool: "apply_patch" })
    expect(PermissionRuleSyntax.parse("tool_search")).toEqual({ raw: "tool_search", tool: "tool_search" })
  })

  test("preserves unknown generated tool IDs exactly", () => {
    expect(PermissionRuleSyntax.parse("MyServer_MyTool")).toEqual({
      raw: "MyServer_MyTool",
      tool: "MyServer_MyTool",
    })
    expect(PermissionRuleSyntax.parse("web_search")).toEqual({
      raw: "web_search",
      tool: "web_search",
    })
  })

  test("parses scoped names and bash command syntax", () => {
    expect(PermissionRuleSyntax.parse("Bash(npm:*)")).toEqual({
      raw: "Bash(npm:*)",
      tool: "bash",
      pattern: "npm *",
    })
    expect(PermissionRuleSyntax.format(PermissionRuleSyntax.parse("Bash(npm:*)"))).toBe("bash(npm *)")
  })

  test("treats empty and wildcard scopes as whole-tool rules", () => {
    expect(PermissionRuleSyntax.format(PermissionRuleSyntax.parse("Tool()"))).toBe("Tool")
    expect(PermissionRuleSyntax.format(PermissionRuleSyntax.parse("Tool(*)"))).toBe("Tool")
  })

  test("supports escaped delimiters", () => {
    expect(PermissionRuleSyntax.parse(String.raw`my\(tool\)(a\)b\\c)`)).toEqual({
      raw: String.raw`my\(tool\)(a\)b\\c)`,
      tool: "my(tool)",
      pattern: String.raw`a)b\c`,
    })
    expect(PermissionRuleSyntax.format(PermissionRuleSyntax.parse(String.raw`my\(tool\)(a\)b\\c)`))).toBe(
      String.raw`my\(tool\)(a\)b\\c)`,
    )
  })

  test("rejects malformed input", () => {
    expect(() => PermissionRuleSyntax.parse("")).toThrow(/empty/)
    expect(() => PermissionRuleSyntax.parse("Bash(npm:*")).toThrow(/missing closing/)
    expect(() => PermissionRuleSyntax.parse("Bash)")).toThrow(/unmatched closing/)
    expect(() => PermissionRuleSyntax.parse("Bash)(npm:*)")).toThrow(/unmatched closing/)
    expect(() => PermissionRuleSyntax.parse("Bash(npm:*)extra")).toThrow(/unexpected text/)
    expect(() => PermissionRuleSyntax.parse("(npm:*)")).toThrow(/tool name/)
  })
})
