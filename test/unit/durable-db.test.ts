import { describe, expect, test } from "bun:test"
import { SqliteAdapter } from "../../src/reliability/sqlite.js"
import { AgentRegistry } from "../../src/agents/registry.js"
import { RunManager } from "../../src/application/run-manager.js"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("durable SQLite file backend (FR-090)", () => {
  test("state survives close + reopen (restart simulation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "titan-db-"))
    const file = join(dir, "nested", "titan.db")

    // First "instance": create a run + task, journal it.
    const db1 = await SqliteAdapter.open({ file })
    const mgr1 = new RunManager(db1, new AgentRegistry())
    const run = await mgr1.createRun({
      goal: "durable goal",
      tasks: [{ type: "exploration", title: "t1" }],
    })
    const tasks1 = await mgr1.getTasks(run.id)
    await mgr1.transitionTask(tasks1[0]!.id, "READY")
    await db1.close()

    // Second "instance" (simulated restart): same file, fresh adapter.
    const db2 = await SqliteAdapter.open({ file })
    const mgr2 = new RunManager(db2, new AgentRegistry())
    const reopened = await mgr2.getRun(run.id)
    expect(reopened?.goal).toBe("durable goal")
    expect(reopened?.status).toBe("CREATED")
    const tasks2 = await mgr2.getTasks(run.id)
    expect(tasks2[0]!.status).toBe("READY")

    // Event journal survived too.
    const events = await db2.listEvents({ runId: run.id })
    expect(events.length).toBeGreaterThanOrEqual(2) // run.created + task.transition

    // Then a recovery pass makes progress without losing anything.
    const { recover } = await import("../../src/reliability/recovery.js")
    const report = await recover(db2, mgr2)
    expect(report.runsScanned).toBe(1)
    await db2.close()
  })

  test("two adapters on the same file see committed writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "titan-db2-"))
    const file = join(dir, "titan.db")
    const dbA = await SqliteAdapter.open({ file })
    const dbB = await SqliteAdapter.open({ file })
    const mgr = new RunManager(dbA, new AgentRegistry())
    const run = await mgr.createRun({ goal: "shared" })
    const fromB = await dbB.getRun(run.id)
    expect(fromB?.goal).toBe("shared")
    await dbA.close()
    await dbB.close()
  })
})
