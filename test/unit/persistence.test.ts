import { describe, expect, test } from "bun:test"
import { SqliteAdapter } from "../../src/reliability/sqlite.js"

async function open() {
  return SqliteAdapter.open()
}

describe("SQLite adapter — driver selection (ADR-004)", () => {
  test("opens with a real SQLite driver (not json-fallback)", async () => {
    const db = await open()
    expect(db.driver).not.toBe("json-fallback")
    expect(["bun-sqlite", "node-sqlite"]).toContain(db.driver)
    await db.close()
  })

  test("init creates schema and reports correct version", async () => {
    const db = await open()
    expect(db.schemaVersion).toBe(1)
    const integrity = await db.verifyIntegrity()
    expect(integrity.ok).toBe(true)
    await db.close()
  })
})

describe("SQLite adapter — runs & tasks", () => {
  test("put/get round-trip a run", async () => {
    const db = await open()
    await db.putRun({
      id: "RUN-1",
      goal: "test goal",
      status: "CREATED",
      mode: "direct",
      budget: "{}",
      createdAt: 1,
      updatedAt: 1,
    })
    const got = await db.getRun("RUN-1")
    expect(got?.goal).toBe("test goal")
    expect(got?.status).toBe("CREATED")
    await db.close()
  })

  test("upsert updates a run without duplicating", async () => {
    const db = await open()
    const base = { id: "RUN-2", goal: "g", status: "CREATED", mode: "direct", budget: "{}", createdAt: 1, updatedAt: 1 }
    await db.putRun(base)
    await db.putRun({ ...base, status: "RUNNING", updatedAt: 2 })
    const all = await db.listRuns()
    expect(all.filter((r) => r.id === "RUN-2")).toHaveLength(1)
    expect((await db.getRun("RUN-2"))?.status).toBe("RUNNING")
    await db.close()
  })

  test("put/get task with JSON fields", async () => {
    const db = await open()
    await db.putTask({
      id: "TASK-1",
      runId: "RUN-1",
      type: "implementation",
      title: "Do thing",
      status: "READY",
      priority: "HIGH",
      dependencies: JSON.stringify(["TASK-0"]),
      inputArtifactIds: "[]",
      acceptanceCriteria: JSON.stringify([{ id: "AC-1", statement: "works", evidenceRequired: true }]),
      limits: JSON.stringify({ maxAttempts: 3, timeoutSeconds: 60 }),
      idempotencyKey: "RUN-1:TASK-1",
      attempts: 0,
      evidence: "[]",
      createdAt: 1,
      updatedAt: 1,
    })
    const got = await db.getTask("TASK-1")
    expect(got?.status).toBe("READY")
    expect(JSON.parse(got!.dependencies)).toEqual(["TASK-0"])
    const byRun = await db.listTasksByRun("RUN-1")
    expect(byRun).toHaveLength(1)
    await db.close()
  })
})

describe("SQLite adapter — event journal (FR-091)", () => {
  test("append assigns increasing seq", async () => {
    const db = await open()
    const e1 = await db.appendEvent({ type: "a", schemaVersion: 1, payload: "{}", at: 1 })
    const e2 = await db.appendEvent({ type: "b", schemaVersion: 1, payload: "{}", at: 2 })
    expect(e2.seq).toBeGreaterThan(e1.seq)
    expect(await db.lastSeq()).toBe(e2.seq)
    await db.close()
  })

  test("idempotent: same correlationId+payload dedupes (FR-096)", async () => {
    const db = await open()
    const evt = { type: "x", correlationId: "c1", schemaVersion: 1, payload: '{"k":1}', at: 1 }
    const a = await db.appendEvent(evt)
    const b = await db.appendEvent(evt)
    expect(b.seq).toBe(a.seq) // deduped, not a new row
    const all = await db.listEvents()
    expect(all.filter((e) => e.correlationId === "c1")).toHaveLength(1)
    await db.close()
  })

  test("filter by runId and sinceSeq", async () => {
    const db = await open()
    await db.appendEvent({ type: "t", runId: "R1", schemaVersion: 1, payload: "{}", at: 1 })
    await db.appendEvent({ type: "t", runId: "R2", schemaVersion: 1, payload: "{}", at: 2 })
    const r1 = await db.listEvents({ runId: "R1" })
    expect(r1).toHaveLength(1)
    const since = await db.listEvents({ sinceSeq: 0 })
    expect(since.length).toBeGreaterThanOrEqual(2)
    await db.close()
  })
})

describe("SQLite adapter — leases (FR-054)", () => {
  test("second owner cannot steal an active lease", async () => {
    const db = await open()
    const ok1 = await db.acquireLease("T1", "ownerA", 60_000)
    expect(ok1).toBe(true)
    const ok2 = await db.acquireLease("T1", "ownerB", 60_000)
    expect(ok2).toBe(false)
    // release then retry
    await db.releaseLease("T1", "ownerA")
    expect(await db.acquireLease("T1", "ownerB", 60_000)).toBe(true)
    await db.close()
  })

  test("expired lease can be re-acquired", async () => {
    const db = await open()
    await db.acquireLease("T2", "dead", -1) // already expired
    expect(await db.acquireLease("T2", "fresh", 60_000)).toBe(true)
    await db.close()
  })

  test("expireLeases clears stale entries", async () => {
    const db = await open()
    await db.acquireLease("T3", "a", -1)
    const n = await db.expireLeases(Date.now())
    expect(n).toBeGreaterThanOrEqual(1)
    await db.close()
  })
})

describe("SQLite adapter — approvals (NFR-024)", () => {
  test("approval is scoped to action+resource and persists decision", async () => {
    const db = await open()
    await db.putApproval({
      id: "AP-1",
      runId: "R1",
      action: "git.push",
      resource: "origin/main",
      requestedBy: "worker-1",
      reason: "deliver",
      status: "pending",
    })
    const pending = await db.listPendingApprovals()
    expect(pending.some((a) => a.id === "AP-1")).toBe(true)
    await db.putApproval({
      id: "AP-1",
      runId: "R1",
      action: "git.push",
      resource: "origin/main",
      requestedBy: "worker-1",
      reason: "deliver",
      status: "approved",
      decidedBy: "user",
      decidedAt: 123,
    })
    expect((await db.listPendingApprovals()).some((a) => a.id === "AP-1")).toBe(false)
    expect((await db.getApproval("AP-1"))?.status).toBe("approved")
    await db.close()
  })
})

describe("SQLite adapter — budget", () => {
  test("put/get/update budget", async () => {
    const db = await open()
    await db.putBudget({
      runId: "R1",
      maxConcurrentWorkers: 4,
      maxAttemptsPerTask: 3,
      maxTotalSeconds: 3600,
      usedModelCalls: 0,
      usedEstimatedCostUsd: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    await db.updateBudget("R1", { usedModelCalls: 5 })
    const b = await db.getBudget("R1")
    expect(b?.usedModelCalls).toBe(5)
    expect(b?.maxConcurrentWorkers).toBe(4)
    await db.close()
  })
})

describe("SQLite adapter — agent runs", () => {
  test("link session to task/run and look up by session (FR-034, FR-056)", async () => {
    const db = await open()
    await db.putAgentRun({
      id: "AR-1",
      runId: "R1",
      taskId: "T1",
      role: "implementer",
      sessionId: "ses_abc",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    })
    const bySession = await db.findAgentRunBySession("ses_abc")
    expect(bySession?.taskId).toBe("T1")
    expect((await db.listAgentRunsByRun("R1"))).toHaveLength(1)
    await db.close()
  })
})

describe("SQLite adapter — integrity & retention", () => {
  test("verifyIntegrity flags orphan tasks", async () => {
    const db = await open()
    await db.putTask({
      id: "ORPHAN",
      runId: "MISSING-RUN",
      type: "test",
      title: "orphan",
      status: "READY",
      priority: "LOW",
      dependencies: "[]",
      inputArtifactIds: "[]",
      acceptanceCriteria: "[]",
      limits: "{}",
      idempotencyKey: "k",
      attempts: 0,
      evidence: "[]",
      createdAt: 1,
      updatedAt: 1,
    })
    const res = await db.verifyIntegrity()
    expect(res.ok).toBe(false)
    expect(res.issues.some((i) => i.includes("orphan"))).toBe(true)
    await db.close()
  })

  test("purgeRunsOlderThan removes closed runs and their children", async () => {
    const db = await open()
    await db.putRun({ id: "OLD", goal: "g", status: "CLOSED", mode: "direct", budget: "{}", createdAt: 1, updatedAt: 1 })
    await db.putTask({
      id: "OLD-T",
      runId: "OLD",
      type: "test",
      title: "t",
      status: "SUCCEEDED",
      priority: "LOW",
      dependencies: "[]",
      inputArtifactIds: "[]",
      acceptanceCriteria: "[]",
      limits: "{}",
      idempotencyKey: "k",
      attempts: 1,
      evidence: "[]",
      createdAt: 1,
      updatedAt: 1,
    })
    const n = await db.purgeRunsOlderThan(Date.now() + 1000)
    expect(n).toBe(1)
    expect(await db.getRun("OLD")).toBeUndefined()
    expect(await db.getTask("OLD-T")).toBeUndefined()
    await db.close()
  })
})
