import { describe, expect, test } from "bun:test"
import { AgentRegistry, BUILTIN_ROLES, RoleNotFoundError } from "../../src/agents/registry.js"

describe("Agent Registry (FR-030)", () => {
  test("registers builtin roles with required fields", () => {
    const reg = new AgentRegistry()
    expect(reg.list().length).toBeGreaterThanOrEqual(10)
    for (const role of reg.list()) {
      const issues = AgentRegistry.validate(role)
      expect(issues).toEqual([])
    }
  })

  test("role is separate from OpenCode agent/model/session (FR-031)", () => {
    const reg = new AgentRegistry()
    const impl = reg.get("implementer")
    // Role has no OpenCode session/agent binding — it's pure domain data.
    expect(impl).not.toHaveProperty("sessionId")
    expect(impl).not.toHaveProperty("opencodeAgentId")
    expect(impl.id).toBe("implementer")
  })

  test("get throws RoleNotFoundError for unknown role", () => {
    const reg = new AgentRegistry()
    expect(() => reg.get("nope")).toThrow(RoleNotFoundError)
  })

  test("forTaskType filters by suitable types", () => {
    const reg = new AgentRegistry()
    const implRoles = reg.forTaskType("implementation")
    expect(implRoles.some((r) => r.id === "implementer")).toBe(true)
    expect(implRoles.every((r) => r.suitableTaskTypes.includes("implementation"))).toBe(true)
  })

  test("selectFor picks lowest-risk suitable role by default", () => {
    const reg = new AgentRegistry()
    const chosen = reg.selectFor("review")
    expect(chosen.riskLevel).toBe("low")
    expect(chosen.suitableTaskTypes).toContain("review")
  })

  test("selectFor honors an explicit preferred role", () => {
    const reg = new AgentRegistry()
    const chosen = reg.selectFor("implementation", "implementer")
    expect(chosen.id).toBe("implementer")
  })

  test("selectFor rejects a preferred role unsuitable for the type", () => {
    const reg = new AgentRegistry()
    expect(() => reg.selectFor("review", "implementer")).toThrow(/not suitable/)
  })

  test("selectFor throws when no role fits the type", () => {
    const reg = new AgentRegistry(BUILTIN_ROLES.filter(() => false))
    expect(() => reg.selectFor("implementation")).toThrow(/No role registered/)
  })

  test("register replaces an existing role (FR-037 override)", () => {
    const reg = new AgentRegistry()
    const before = reg.get("implementer").riskLevel
    reg.register({ ...reg.get("implementer"), riskLevel: "high" })
    expect(reg.get("implementer").riskLevel).toBe("high")
    expect(before).not.toBe("high")
    expect(reg.list().filter((r) => r.id === "implementer")).toHaveLength(1)
  })

  test("remove disables a role (FR-037)", () => {
    const reg = new AgentRegistry()
    expect(reg.remove("debugger")).toBe(true)
    expect(reg.has("debugger")).toBe(false)
    expect(() => reg.get("debugger")).toThrow(RoleNotFoundError)
  })
})

describe("least privilege tool policy (FR-100, FR-101)", () => {
  test("read-only roles cannot use write/edit/bash", () => {
    const reg = new AgentRegistry()
    expect(reg.canUseTool("explorer", "read")).toBe(true)
    expect(reg.canUseTool("explorer", "write")).toBe(false)
    expect(reg.canUseTool("explorer", "edit")).toBe(false)
    expect(reg.canUseTool("explorer", "bash")).toBe(false)
  })

  test("implementer can write within its scope", () => {
    const reg = new AgentRegistry()
    expect(reg.canUseTool("implementer", "write")).toBe(true)
    expect(reg.canUseTool("implementer", "edit")).toBe(true)
  })

  test("denied list wins over allowed list", () => {
    const reg = new AgentRegistry()
    // test-engineer allows bash but denies write/edit
    expect(reg.canUseTool("test-engineer", "bash")).toBe(true)
    expect(reg.canUseTool("test-engineer", "write")).toBe(false)
    expect(reg.canUseTool("test-engineer", "edit")).toBe(false)
  })

  test("orchestrator is coordination-only (no write)", () => {
    const reg = new AgentRegistry()
    expect(reg.canUseTool("orchestrator", "write")).toBe(false)
    expect(reg.canUseTool("orchestrator", "bash")).toBe(false)
    expect(reg.canUseTool("orchestrator", "read")).toBe(true)
  })

  test("allowedToolSet returns the exact allowlist for context-hook restriction", () => {
    const reg = new AgentRegistry()
    const tools = reg.allowedToolSet("reviewer")
    expect(tools.has("read")).toBe(true)
    expect(tools.has("write")).toBe(false)
    expect(tools.has("bash")).toBe(false)
  })
})
