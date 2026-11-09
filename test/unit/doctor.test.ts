import { describe, expect, test } from "bun:test"
import {
  MIN_OPENCODE_VERSION,
  parseVersion,
  runDoctor,
  verdict,
  renderDoctor,
  versionGte,
  type DoctorCheck,
  type DoctorSources,
} from "../../src/application/doctor.js"

function fakeSources(overrides: Partial<DoctorSources> = {}): DoctorSources {
  return {
    appVersion: () => "2.2.5",
    pluginId: () => "titan.orchestrator",
    location: () => ({ directory: "/proj", project: "proj-1" }),
    models: async () => [
      { providerID: "opencode", modelID: "iceman-free" },
      { providerID: "openai", modelID: "gpt-x" },
    ],
    storageProbe: async () => true,
    vcsBranch: async () => "main",
    vcsChangedFiles: async () => 3,
    permissionRuleCount: async () => 5,
    ...overrides,
  }
}

describe("version comparison (FR-002)", () => {
  test("parseVersion extracts x.y.z", () => {
    expect(parseVersion("2.2.5")).toEqual({ major: 2, minor: 2, patch: 5 })
    expect(parseVersion("v1.0.0")).toEqual({ major: 1, minor: 0, patch: 0 })
    expect(parseVersion("garbage")).toBeNull()
  })

  test("versionGte semantics", () => {
    expect(versionGte("2.2.5", "2.0.0")).toBe(true)
    expect(versionGte("2.0.0", "2.0.0")).toBe(true)
    expect(versionGte("1.9.9", "2.0.0")).toBe(false)
    expect(versionGte("3.0.0", "2.9.9")).toBe(true)
    expect(versionGte("2.1.0", "2.2.0")).toBe(false)
    expect(versionGte("not-a-version", "2.0.0")).toBe(false) // unparseable → not supported
  })

  test("minimum version is 2.x (V2 only, never V1)", () => {
    expect(MIN_OPENCODE_VERSION.startsWith("2.")).toBe(true)
    expect(versionGte("1.15.7", MIN_OPENCODE_VERSION)).toBe(false) // the stale V1 install
  })
})

describe("runDoctor (FR-007)", () => {
  test("healthy environment → all PASS, verdict PASS", async () => {
    const checks = await runDoctor(fakeSources())
    expect(checks.length).toBeGreaterThanOrEqual(7)
    expect(checks.every((c) => c.status === "PASS")).toBe(true)
    expect(verdict(checks)).toBe("PASS")
  })

  test("unsupported OpenCode version → FAIL (must not hide it, FR-002)", async () => {
    const checks = await runDoctor(fakeSources({ appVersion: () => "1.15.7" }))
    const v = checks.find((c) => c.id === "opencode-version")
    expect(v?.status).toBe("FAIL")
    expect(v?.detail).toContain("cannot run in unsupported mode")
    expect(verdict(checks)).toBe("FAIL")
  })

  test("no models discovered → FAIL (routing impossible)", async () => {
    const checks = await runDoctor(fakeSources({ models: async () => [] }))
    const m = checks.find((c) => c.id === "models")
    expect(m?.status).toBe("FAIL")
  })

  test("model list throwing → FAIL, not a crash", async () => {
    const checks = await runDoctor(
      fakeSources({
        models: async () => {
          throw new Error("provider down")
        },
      }),
    )
    const m = checks.find((c) => c.id === "models")
    expect(m?.status).toBe("FAIL")
    expect(m?.detail).toContain("provider down")
    expect(verdict(checks)).toBe("FAIL")
  })

  test("storage probe failure → FAIL", async () => {
    const checks = await runDoctor(fakeSources({ storageProbe: async () => false }))
    expect(checks.find((c) => c.id === "storage")?.status).toBe("FAIL")
  })

  test("no git branch → WARN (not FAIL: repo may legitimately be branchless)", async () => {
    const checks = await runDoctor(fakeSources({ vcsBranch: async () => null }))
    const v = checks.find((c) => c.id === "vcs")
    expect(v?.status).toBe("WARN")
    expect(verdict(checks)).toBe("WARN")
  })

  test("permission check without session → WARN with reason", async () => {
    const checks = await runDoctor(
      fakeSources({
        permissionRuleCount: async () => {
          throw new Error("no session available to scope the permission check")
        },
      }),
    )
    const p = checks.find((c) => c.id === "permissions")
    expect(p?.status).toBe("WARN")
    expect(p?.detail).toContain("no session")
  })

  test("verdict precedence: FAIL beats WARN beats PASS", () => {
    const mk = (status: DoctorCheck["status"]): DoctorCheck => ({
      id: "x",
      label: "x",
      status,
      detail: "",
    })
    expect(verdict([mk("PASS"), mk("WARN"), mk("FAIL")])).toBe("FAIL")
    expect(verdict([mk("PASS"), mk("WARN")])).toBe("WARN")
    expect(verdict([mk("PASS")])).toBe("PASS")
    expect(verdict([])).toBe("PASS")
  })

  test("renderDoctor includes every check and the verdict", async () => {
    const checks = await runDoctor(fakeSources({ appVersion: () => "1.0.0" }))
    const text = renderDoctor(checks)
    expect(text).toContain("TITAN doctor")
    expect(text).toContain("Overall: FAIL")
    expect(text).toContain("✘") // failure icon present
    for (const c of checks) expect(text).toContain(c.label)
  })

  test("sessionID is forwarded to the permission check", async () => {
    let seen: string | undefined
    await runDoctor(
      fakeSources({
        permissionRuleCount: async (sid) => {
          seen = sid
          return 1
        },
      }),
      { sessionID: "ses_abc" },
    )
    expect(seen).toBe("ses_abc")
  })
})
