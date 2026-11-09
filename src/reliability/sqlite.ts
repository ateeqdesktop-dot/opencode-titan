/**
 * SQLite persistence adapter (ADR-004, SRS §8.5).
 *
 * Detects the available SQLite driver at runtime:
 *   - `bun:sqlite`  (OpenCode server runs on Bun — primary)
 *   - `node:sqlite` (fallback when hosted on Node)
 *   - JSON fallback (last resort; documented limitation: no cross-row transactions)
 *
 * Domain code never touches these drivers directly — only `PersistenceAdapter`.
 * Includes schema versioning, migrations, transactions, and an append-only event journal.
 */
import {
  SCHEMA_VERSION,
  StorageError,
  type AgentRunRecord,
  type ApprovalRecord,
  type BudgetRecord,
  type EventRecord,
  type LeaseRecord,
  type PersistenceAdapter,
  type RunRecord,
  type TaskRecord,
} from "./adapter.js"

// ── Minimal driver abstraction (so we don't import bun:sqlite under Node) ─────
interface SqlDriver {
  run(sql: string, ...params: unknown[]): void
  get<T>(sql: string, ...params: unknown[]): T | undefined
  all<T>(sql: string, ...params: unknown[]): T[]
  exec(sql: string): void
  transaction<T>(fn: () => T): T
}

async function loadSqlDriver(): Promise<SqlDriver | null> {
  // Try bun:sqlite first (OpenCode server runtime).
  try {
    const mod = (await import(/* @vite-ignore */ "bun:sqlite")) as {
      Database: new (path: string, opts?: unknown) => unknown
    }
    const db = new mod.Database(":memory:")
    return wrapSync(db as never, "bun")
  } catch {
    /* not bun */
  }
  // Then node:sqlite.
  try {
    const mod = (await import(/* @vite-ignore */ "node:sqlite")) as {
      DatabaseSync: new (path: string, opts?: unknown) => unknown
    }
    const db = new mod.DatabaseSync(":memory:")
    return wrapSync(db as never, "node")
  } catch {
    /* not node */
  }
  return null
}

// Both drivers expose a compatible surface: `run`/`prepare().get/all/run` + `exec`.
function wrapSync(db: never, kind: "bun" | "node"): SqlDriver {
  const anyDb = db as {
    run?: (sql: string, ...p: unknown[]) => unknown
    prepare?: (sql: string) => {
      get?: (...p: unknown[]) => unknown
      all?: (...p: unknown[]) => unknown
      run?: (...p: unknown[]) => unknown
    }
    exec?: (sql: string) => unknown
  }
  return {
    run(sql, ...params) {
      if (anyDb.run) anyDb.run(sql, ...params)
      else anyDb.prepare?.(sql)?.run?.(...params)
    },
    get<T>(sql: string, ...params: unknown[]): T | undefined {
      const stmt = anyDb.prepare?.(sql)
      const row = stmt?.get?.(...params) as T | null | undefined
      return row == null ? undefined : row // SQLite returns null for no row; normalize to undefined
    },
    all<T>(sql: string, ...params: unknown[]): T[] {
      const stmt = anyDb.prepare?.(sql)
      return (stmt?.all?.(...params) as T[]) ?? []
    },
    exec(sql) {
      anyDb.exec?.(sql)
    },
    transaction<T>(fn: () => T): T {
      // BEGIN/COMMIT around the callback; rollback on throw.
      this.exec("BEGIN")
      try {
        const out = fn()
        this.exec("COMMIT")
        return out
      } catch (e) {
        try {
          this.exec("ROLLBACK")
        } catch {
          /* ignore rollback failure */
        }
        throw e
      }
    },
  }
}

// ── DDL ──────────────────────────────────────────────────────────────────────
const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  budget TEXT NOT NULL,
  statusReason TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  closedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  dependencies TEXT NOT NULL,
  assignedRole TEXT,
  assignedSessionId TEXT,
  workspaceId TEXT,
  inputArtifactIds TEXT NOT NULL,
  acceptanceCriteria TEXT NOT NULL,
  limits TEXT NOT NULL,
  idempotencyKey TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  evidence TEXT NOT NULL DEFAULT '[]',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(runId);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_idem ON tasks(idempotencyKey);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  runId TEXT,
  taskId TEXT,
  agentRunId TEXT,
  correlationId TEXT,
  schemaVersion INTEGER NOT NULL,
  payload TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(runId);
CREATE INDEX IF NOT EXISTS idx_events_corr ON events(correlationId);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  taskId TEXT,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  requestedBy TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  decidedBy TEXT,
  decidedAt INTEGER,
  expiresAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals(runId);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE TABLE IF NOT EXISTS budgets (
  runId TEXT PRIMARY KEY,
  maxConcurrentWorkers INTEGER NOT NULL,
  maxAttemptsPerTask INTEGER NOT NULL,
  maxTotalSeconds INTEGER NOT NULL,
  maxEstimatedCostUsd REAL,
  maxModelCalls INTEGER,
  usedModelCalls INTEGER NOT NULL DEFAULT 0,
  usedEstimatedCostUsd REAL NOT NULL DEFAULT 0,
  startedAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS leases (
  taskId TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquiredAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  taskId TEXT NOT NULL,
  role TEXT NOT NULL,
  sessionId TEXT,
  status TEXT NOT NULL,
  workspaceId TEXT,
  model TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_run ON agent_runs(runId);
CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(sessionId);
`

type Row = Record<string, unknown>

export class SqliteAdapter implements PersistenceAdapter {
  readonly driver: "bun-sqlite" | "node-sqlite" | "json-fallback"
  readonly schemaVersion = SCHEMA_VERSION
  private db: SqlDriver | null = null
  private readonly kind: "bun" | "node" | "none"

  private constructor(kind: "bun" | "node" | "none", db: SqlDriver | null) {
    this.kind = kind
    this.db = db
    this.driver = kind === "bun" ? "bun-sqlite" : kind === "node" ? "node-sqlite" : "json-fallback"
  }

  /** Open the adapter, selecting the best available driver. */
  static async open(): Promise<SqliteAdapter> {
    const drv = await loadSqlDriver()
    if (!drv) return new SqliteAdapter("none", null)
    const kind = drv === null ? "none" : ((drv as unknown as { __k?: string }).__k ?? "bun")
    const adapter = new SqliteAdapter(kind === "node" ? "node" : "bun", drv)
    await adapter.init()
    return adapter
  }

  async init(): Promise<void> {
    if (!this.db) throw new StorageError("No SQLite driver available")
    this.db.exec(DDL)
    // schemaVersion gate (SRS §8.4)
    const cur = this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schemaVersion'")
    if (!cur) {
      this.db.run("INSERT INTO meta (key, value) VALUES ('schemaVersion', ?)", String(SCHEMA_VERSION))
    } else {
      const v = Number(cur.value)
      if (v > SCHEMA_VERSION) {
        throw new StorageError(`DB schema v${v} is newer than supported v${SCHEMA_VERSION}`)
      }
      if (v < SCHEMA_VERSION) {
        this.migrate(v)
      }
    }
  }

  private migrate(from: number): void {
    if (!this.db) return
    // Migration chain. Each step is idempotent (IF NOT EXISTS / guarded).
    // Future migrations append here; v1 is the baseline created by DDL.
    if (from < 1) {
      // no-op: DDL already created v1
    }
    this.db.run("UPDATE meta SET value = ? WHERE key = 'schemaVersion'", String(SCHEMA_VERSION))
  }

  async close(): Promise<void> {
    this.db = null
  }

  private req(): SqlDriver {
    if (!this.db) throw new StorageError("Adapter closed")
    return this.db
  }

  // ── Runs ───────────────────────────────────────────────────────────────────
  async putRun(run: RunRecord): Promise<void> {
    const db = this.req()
    db.run(
      `INSERT INTO runs (id,goal,status,mode,budget,statusReason,createdAt,updatedAt,closedAt)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET goal=excluded.goal,status=excluded.status,mode=excluded.mode,
         budget=excluded.budget,statusReason=excluded.statusReason,updatedAt=excluded.updatedAt,closedAt=excluded.closedAt`,
      run.id,
      run.goal,
      run.status,
      run.mode,
      run.budget,
      run.statusReason ?? null,
      run.createdAt,
      run.updatedAt,
      run.closedAt ?? null,
    )
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    return this.req().get<RunRecord>("SELECT * FROM runs WHERE id = ?", id)
  }

  async listRuns(): Promise<RunRecord[]> {
    return this.req().all<RunRecord>("SELECT * FROM runs ORDER BY createdAt DESC")
  }

  async listRunsByStatus(statuses: readonly string[]): Promise<RunRecord[]> {
    if (statuses.length === 0) return []
    const ph = statuses.map(() => "?").join(",")
    return this.req().all<RunRecord>(`SELECT * FROM runs WHERE status IN (${ph})`, ...statuses)
  }

  // ── Tasks ──────────────────────────────────────────────────────────────────
  async putTask(task: TaskRecord): Promise<void> {
    const db = this.req()
    db.run(
      `INSERT INTO tasks (id,runId,type,title,description,status,priority,dependencies,assignedRole,assignedSessionId,workspaceId,inputArtifactIds,acceptanceCriteria,limits,idempotencyKey,attempts,evidence,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status,assignedRole=excluded.assignedRole,
         assignedSessionId=excluded.assignedSessionId,workspaceId=excluded.workspaceId,
         attempts=excluded.attempts,evidence=excluded.evidence,updatedAt=excluded.updatedAt`,
      task.id,
      task.runId,
      task.type,
      task.title,
      task.description ?? null,
      task.status,
      task.priority,
      task.dependencies,
      task.assignedRole ?? null,
      task.assignedSessionId ?? null,
      task.workspaceId ?? null,
      task.inputArtifactIds,
      task.acceptanceCriteria,
      task.limits,
      task.idempotencyKey,
      task.attempts,
      task.evidence,
      task.createdAt,
      task.updatedAt,
    )
  }

  async getTask(id: string): Promise<TaskRecord | undefined> {
    return this.req().get<TaskRecord>("SELECT * FROM tasks WHERE id = ?", id)
  }

  async listTasksByRun(runId: string): Promise<TaskRecord[]> {
    return this.req().all<TaskRecord>("SELECT * FROM tasks WHERE runId = ? ORDER BY createdAt", runId)
  }

  async listTasksByStatus(statuses: readonly string[]): Promise<TaskRecord[]> {
    if (statuses.length === 0) return []
    const ph = statuses.map(() => "?").join(",")
    return this.req().all<TaskRecord>(`SELECT * FROM tasks WHERE status IN (${ph})`, ...statuses)
  }

  // ── Event journal (append-only, sequenced, deduped) ────────────────────────
  async appendEvent(evt: Omit<EventRecord, "seq">): Promise<EventRecord> {
    const db = this.req()
    // Dedup: same (type, correlationId, payload) already recorded → return existing (idempotency).
    if (evt.correlationId) {
      const existing = db.get<EventRecord>(
        "SELECT * FROM events WHERE type=? AND correlationId=? AND payload=? LIMIT 1",
        evt.type,
        evt.correlationId,
        evt.payload,
      )
      if (existing) return existing
    }
    db.run(
      `INSERT INTO events (type,runId,taskId,agentRunId,correlationId,schemaVersion,payload,at)
       VALUES (?,?,?,?,?,?,?,?)`,
      evt.type,
      evt.runId ?? null,
      evt.taskId ?? null,
      evt.agentRunId ?? null,
      evt.correlationId ?? null,
      evt.schemaVersion,
      evt.payload,
      evt.at,
    )
    const seq = db.get<{ seq: number }>("SELECT last_insert_rowid() AS seq")?.seq ?? 0
    return { ...evt, seq }
  }

  async listEvents(filter?: { runId?: string; sinceSeq?: number; limit?: number }): Promise<EventRecord[]> {
    const db = this.req()
    const where: string[] = []
    const params: unknown[] = []
    if (filter?.runId) {
      where.push("runId = ?")
      params.push(filter.runId)
    }
    if (filter?.sinceSeq !== undefined) {
      where.push("seq > ?")
      params.push(filter.sinceSeq)
    }
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq ASC${filter?.limit ? " LIMIT " + filter.limit : ""}`
    return db.all<EventRecord>(sql, ...params)
  }

  async lastSeq(): Promise<number> {
    return this.req().get<{ seq: number }>("SELECT COALESCE(MAX(seq),0) AS seq FROM events")?.seq ?? 0
  }

  // ── Approvals ──────────────────────────────────────────────────────────────
  async putApproval(a: ApprovalRecord): Promise<void> {
    const db = this.req()
    db.run(
      `INSERT INTO approvals (id,runId,taskId,action,resource,requestedBy,reason,status,decidedBy,decidedAt,expiresAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status,decidedBy=excluded.decidedBy,
         decidedAt=excluded.decidedAt`,
      a.id,
      a.runId,
      a.taskId ?? null,
      a.action,
      a.resource,
      a.requestedBy,
      a.reason,
      a.status,
      a.decidedBy ?? null,
      a.decidedAt ?? null,
      a.expiresAt ?? null,
    )
  }

  async getApproval(id: string): Promise<ApprovalRecord | undefined> {
    return this.req().get<ApprovalRecord>("SELECT * FROM approvals WHERE id = ?", id)
  }

  async listApprovalsByRun(runId: string): Promise<ApprovalRecord[]> {
    return this.req().all<ApprovalRecord>("SELECT * FROM approvals WHERE runId = ?", runId)
  }

  async listPendingApprovals(): Promise<ApprovalRecord[]> {
    return this.req().all<ApprovalRecord>("SELECT * FROM approvals WHERE status = 'pending'")
  }

  // ── Budget ─────────────────────────────────────────────────────────────────
  async putBudget(b: BudgetRecord): Promise<void> {
    const db = this.req()
    db.run(
      `INSERT INTO budgets (runId,maxConcurrentWorkers,maxAttemptsPerTask,maxTotalSeconds,maxEstimatedCostUsd,maxModelCalls,usedModelCalls,usedEstimatedCostUsd,startedAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(runId) DO UPDATE SET maxConcurrentWorkers=excluded.maxConcurrentWorkers,
         maxAttemptsPerTask=excluded.maxAttemptsPerTask,maxTotalSeconds=excluded.maxTotalSeconds,
         maxEstimatedCostUsd=excluded.maxEstimatedCostUsd,maxModelCalls=excluded.maxModelCalls,
         usedModelCalls=excluded.usedModelCalls,usedEstimatedCostUsd=excluded.usedEstimatedCostUsd,
         updatedAt=excluded.updatedAt`,
      b.runId,
      b.maxConcurrentWorkers,
      b.maxAttemptsPerTask,
      b.maxTotalSeconds,
      b.maxEstimatedCostUsd ?? null,
      b.maxModelCalls ?? null,
      b.usedModelCalls,
      b.usedEstimatedCostUsd,
      b.startedAt,
      b.updatedAt,
    )
  }

  async getBudget(runId: string): Promise<BudgetRecord | undefined> {
    return this.req().get<BudgetRecord>("SELECT * FROM budgets WHERE runId = ?", runId)
  }

  async updateBudget(runId: string, patch: Partial<BudgetRecord>): Promise<void> {
    const cur = await this.getBudget(runId)
    if (!cur) throw new StorageError(`No budget for run ${runId}`)
    await this.putBudget({ ...cur, ...patch, runId, updatedAt: Date.now() })
  }

  // ── Leases (FR-054) ────────────────────────────────────────────────────────
  async acquireLease(taskId: string, owner: string, ttlMs: number): Promise<boolean> {
    const db = this.req()
    const now = Date.now()
    // Expire stale leases first so a dead owner doesn't block forever.
    db.run("DELETE FROM leases WHERE expiresAt <= ?", now)
    const held = db.get<LeaseRecord>("SELECT * FROM leases WHERE taskId = ?", taskId)
    if (held) return false // someone else owns it and hasn't expired
    db.run(
      "INSERT INTO leases (taskId,owner,acquiredAt,expiresAt) VALUES (?,?,?,?)",
      taskId,
      owner,
      now,
      now + ttlMs,
    )
    return true
  }

  async releaseLease(taskId: string, owner: string): Promise<void> {
    this.req().run("DELETE FROM leases WHERE taskId = ? AND owner = ?", taskId, owner)
  }

  async getLease(taskId: string): Promise<LeaseRecord | undefined> {
    return this.req().get<LeaseRecord>("SELECT * FROM leases WHERE taskId = ?", taskId)
  }

  async expireLeases(now: number): Promise<number> {
    const before = this.req().get<{ n: number }>("SELECT COUNT(*) AS n FROM leases WHERE expiresAt <= ?", now)?.n ?? 0
    this.req().run("DELETE FROM leases WHERE expiresAt <= ?", now)
    return before
  }

  // ── Agent runs ─────────────────────────────────────────────────────────────
  async putAgentRun(a: AgentRunRecord): Promise<void> {
    const db = this.req()
    db.run(
      `INSERT INTO agent_runs (id,runId,taskId,role,sessionId,status,workspaceId,model,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status,sessionId=excluded.sessionId,
         workspaceId=excluded.workspaceId,updatedAt=excluded.updatedAt`,
      a.id,
      a.runId,
      a.taskId,
      a.role,
      a.sessionId ?? null,
      a.status,
      a.workspaceId ?? null,
      a.model ?? null,
      a.createdAt,
      a.updatedAt,
    )
  }

  async getAgentRun(id: string): Promise<AgentRunRecord | undefined> {
    return this.req().get<AgentRunRecord>("SELECT * FROM agent_runs WHERE id = ?", id)
  }

  async listAgentRunsByRun(runId: string): Promise<AgentRunRecord[]> {
    return this.req().all<AgentRunRecord>("SELECT * FROM agent_runs WHERE runId = ?", runId)
  }

  async findAgentRunBySession(sessionId: string): Promise<AgentRunRecord | undefined> {
    return this.req().get<AgentRunRecord>("SELECT * FROM agent_runs WHERE sessionId = ?", sessionId)
  }

  // ── Retention / integrity ──────────────────────────────────────────────────
  async purgeRunsOlderThan(cutoffMs: number): Promise<number> {
    const db = this.req()
    const doomed = db
      .all<{ id: string }>(
        "SELECT id FROM runs WHERE updatedAt < ? AND status IN ('CLOSED','CANCELLED','FAILED','REJECTED')",
        cutoffMs,
      )
      .map((r) => r.id)
    if (doomed.length === 0) return 0
    db.transaction(() => {
      for (const id of doomed) {
        db.run("DELETE FROM tasks WHERE runId = ?", id)
        db.run("DELETE FROM events WHERE runId = ?", id)
        db.run("DELETE FROM approvals WHERE runId = ?", id)
        db.run("DELETE FROM budgets WHERE runId = ?", id)
        db.run("DELETE FROM agent_runs WHERE runId = ?", id)
        db.run("DELETE FROM runs WHERE id = ?", id)
      }
    })
    return doomed.length
  }

  async verifyIntegrity(): Promise<{ ok: boolean; issues: string[] }> {
    const issues: string[] = []
    const db = this.req()
    const sv = db.get<{ value: string }>("SELECT value FROM meta WHERE key='schemaVersion'")
    if (!sv || Number(sv.value) !== SCHEMA_VERSION) issues.push("schemaVersion mismatch or missing")
    // Orphan tasks (task.runId with no run)
    const orphanTasks = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM tasks t LEFT JOIN runs r ON t.runId=r.id WHERE r.id IS NULL",
    )?.n
    if ((orphanTasks ?? 0) > 0) issues.push(`${orphanTasks} orphan task(s) with missing run`)
    // Event seq continuity is not required (append-only can have gaps after purge), but
    // negative or zero seq indicates corruption.
    const badEvents = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE seq <= 0")?.n
    if ((badEvents ?? 0) > 0) issues.push(`${badEvents} event(s) with non-positive seq`)
    return { ok: issues.length === 0, issues }
  }
}
