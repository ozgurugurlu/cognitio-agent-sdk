import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"
import { RuntimeToolRules } from "../../src/permission/runtime-rules"

describe("runtime tool rules", () => {
  test("strict allowlist exposes only matching tools and denies everything else", () => {
    const policy = RuntimeToolRules.fromConfig({ allowedTools: ["read"] })

    expect(policy.allowed).toEqual(["read"])
    expect(policy.isVisible("read")).toBe(true)
    expect(policy.isVisible("edit")).toBe(false)
    expect(policy.isVisible("bash")).toBe(false)
    expect(Permission.evaluate("read", "*", policy.ruleset).action).toBe("allow")
    expect(Permission.evaluate("edit", "file.ts", policy.ruleset).action).toBe("deny")
  })

  test("disallowed tools hide whole-tool entries", () => {
    const policy = RuntimeToolRules.fromConfig({ disallowedTools: ["write"] })

    expect(policy.disallowed).toEqual(["write"])
    expect(policy.isVisible("read")).toBe(true)
    expect(policy.isVisible("write")).toBe(false)
    expect(Permission.evaluate("write", "file.ts", policy.ruleset).action).toBe("deny")
    expect(Permission.evaluate("edit", "file.ts", policy.ruleset).action).toBe("ask")
  })

  test("exact edit-family denial stays separate from broad edit permission", () => {
    const policy = RuntimeToolRules.fromConfig({ disallowedTools: ["write"] })

    expect(Permission.disabled(["read", "edit", "write", "apply_patch"], policy.toolRuleset)).toEqual(
      new Set(["write"]),
    )
    expect(Permission.evaluate(policy.permissionForAsk("write", "edit"), "file.ts", policy.ruleset).action).toBe(
      "deny",
    )
    expect(Permission.evaluate(policy.permissionForAsk("edit", "edit"), "file.ts", policy.ruleset).action).toBe("ask")
  })

  test("strict exact edit-family allowlist does not allow hidden siblings on ask path", () => {
    const policy = RuntimeToolRules.fromConfig({ allowedTools: ["write"] })

    expect(policy.isVisible("edit")).toBe(false)
    expect(policy.isVisible("write")).toBe(true)
    expect(policy.isVisible("apply_patch")).toBe(false)
    expect(Permission.evaluate("edit", "file.ts", policy.ruleset).action).toBe("deny")
    expect(Permission.evaluate(policy.permissionForAsk("write", "edit"), "file.ts", policy.ruleset).action).toBe(
      "allow",
    )
    expect(Permission.evaluate(policy.permissionForAsk("edit", "edit"), "file.ts", policy.ruleset).action).toBe(
      "deny",
    )
    expect(Permission.evaluate(policy.permissionForAsk("apply_patch", "edit"), "file.ts", policy.ruleset).action).toBe(
      "deny",
    )
  })

  test("runtime deny wins after runtime allow", () => {
    const policy = RuntimeToolRules.fromConfig({ allowedTools: ["read", "bash(*)"], disallowedTools: ["read"] })

    expect(policy.isVisible("read")).toBe(false)
    expect(Permission.evaluate("read", "*", policy.ruleset).action).toBe("deny")
  })

  test("scoped bash rules allow matching commands and deny others under strict allowlist", () => {
    const policy = RuntimeToolRules.fromConfig({ allowedTools: ["bash(npm:*)"] })

    expect(policy.allowed).toEqual(["bash(npm *)"])
    expect(policy.isVisible("bash")).toBe(true)
    expect(Permission.evaluate("bash", "npm install", policy.ruleset).action).toBe("allow")
    expect(Permission.evaluate("bash", "rm -rf node_modules", policy.ruleset).action).toBe("deny")
  })

  test("preserves case for generated MCP tool IDs", () => {
    const policy = RuntimeToolRules.fromConfig({ allowedTools: ["MyServer_MyTool"] })

    expect(policy.allowed).toEqual(["MyServer_MyTool"])
    expect(policy.isVisible("MyServer_MyTool")).toBe(true)
    expect(policy.isVisible("myserver_mytool")).toBe(false)
  })
})
