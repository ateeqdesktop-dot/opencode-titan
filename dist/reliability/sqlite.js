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
import { SCHEMA_VERSION, StorageError, } from "./adapter.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
async function loadSqlDriver(file) {
    // A real (non-memory) file needs its parent directory to exist.
    if (file !== ":memory:")
        mkdirSync(dirname(file), { recursive: true });
    // Try bun:sqlite first (OpenCode server runtime).
    try {
        const mod = (await import(/* @vite-ignore */ "bun:sqlite"));
        const db = new mod.Database(file);
        return wrapSync(db, "bun");
    }
    catch {
        /* not bun */
    }
    // Then node:sqlite.
    try {
        const mod = (await import(/* @vite-ignore */ "node:sqlite"));
        const db = new mod.DatabaseSync(file);
        return wrapSync(db, "node");
    }
    catch {
        /* not node */
    }
    return null;
}
// Both drivers expose a compatible surface: `run`/`prepare().get/all/run` + `exec`.
function wrapSync(db, kind) {
    const anyDb = db;
    return {
        run(sql, ...params) {
            if (anyDb.run)
                anyDb.run(sql, ...params);
            else
                anyDb.prepare?.(sql)?.run?.(...params);
        },
        get(sql, ...params) {
            const stmt = anyDb.prepare?.(sql);
            const row = stmt?.get?.(...params);
            return row == null ? undefined : row; // SQLite returns null for no row; normalize to undefined
        },
        all(sql, ...params) {
            const stmt = anyDb.prepare?.(sql);
            return stmt?.all?.(...params) ?? [];
        },
        exec(sql) {
            anyDb.exec?.(sql);
        },
        transaction(fn) {
            // BEGIN/COMMIT around the callback; rollback on throw.
            this.exec("BEGIN");
            try {
                const out = fn();
                this.exec("COMMIT");
                return out;
            }
            catch (e) {
                try {
                    this.exec("ROLLBACK");
                }
                catch {
                    /* ignore rollback failure */
                }
                throw e;
            }
        },
    };
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
`;
export class SqliteAdapter {
    driver;
    schemaVersion = SCHEMA_VERSION;
    db = null;
    kind;
    constructor(kind, db) {
        this.kind = kind;
        this.db = db;
        this.driver = kind === "bun" ? "bun-sqlite" : kind === "node" ? "node-sqlite" : "json-fallback";
    }
    /**
     * Open the adapter, selecting the best available driver.
     * - `file: ":memory:"` (default when omitted) → ephemeral, used by unit tests.
     * - `file: "<path>"` → durable, survives restarts (SRS FR-090; required for
     *   recovery after OpenCode restarts). The parent directory is created.
     */
    static async open(opts) {
        const file = opts?.file ?? ":memory:";
        const drv = await loadSqlDriver(file);
        if (!drv)
            return new SqliteAdapter("none", null);
        const kind = drv === null ? "none" : (drv.__k ?? "bun");
        const adapter = new SqliteAdapter(kind === "node" ? "node" : "bun", drv);
        await adapter.init();
        return adapter;
    }
    async init() {
        if (!this.db)
            throw new StorageError("No SQLite driver available");
        this.db.exec(DDL);
        // schemaVersion gate (SRS §8.4)
        const cur = this.db.get("SELECT value FROM meta WHERE key = 'schemaVersion'");
        if (!cur) {
            this.db.run("INSERT INTO meta (key, value) VALUES ('schemaVersion', ?)", String(SCHEMA_VERSION));
        }
        else {
            const v = Number(cur.value);
            if (v > SCHEMA_VERSION) {
                throw new StorageError(`DB schema v${v} is newer than supported v${SCHEMA_VERSION}`);
            }
            if (v < SCHEMA_VERSION) {
                this.migrate(v);
            }
        }
    }
    migrate(from) {
        if (!this.db)
            return;
        // Migration chain. Each step is idempotent (IF NOT EXISTS / guarded).
        // Future migrations append here; v1 is the baseline created by DDL.
        if (from < 1) {
            // no-op: DDL already created v1
        }
        this.db.run("UPDATE meta SET value = ? WHERE key = 'schemaVersion'", String(SCHEMA_VERSION));
    }
    async close() {
        this.db = null;
    }
    req() {
        if (!this.db)
            throw new StorageError("Adapter closed");
        return this.db;
    }
    // ── Runs ───────────────────────────────────────────────────────────────────
    async putRun(run) {
        const db = this.req();
        db.run(`INSERT INTO runs (id,goal,status,mode,budget,statusReason,createdAt,updatedAt,closedAt)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET goal=excluded.goal,status=excluded.status,mode=excluded.mode,
         budget=excluded.budget,statusReason=excluded.statusReason,updatedAt=excluded.updatedAt,closedAt=excluded.closedAt`, run.id, run.goal, run.status, run.mode, run.budget, run.statusReason ?? null, run.createdAt, run.updatedAt, run.closedAt ?? null);
    }
    async getRun(id) {
        return this.req().get("SELECT * FROM runs WHERE id = ?", id);
    }
    async listRuns() {
        return this.req().all("SELECT * FROM runs ORDER BY createdAt DESC");
    }
    async listRunsByStatus(statuses) {
        if (statuses.length === 0)
            return [];
        const ph = statuses.map(() => "?").join(",");
        return this.req().all(`SELECT * FROM runs WHERE status IN (${ph})`, ...statuses);
    }
    // ── Tasks ──────────────────────────────────────────────────────────────────
    async putTask(task) {
        const db = this.req();
        db.run(`INSERT INTO tasks (id,runId,type,title,description,status,priority,dependencies,assignedRole,assignedSessionId,workspaceId,inputArtifactIds,acceptanceCriteria,limits,idempotencyKey,attempts,evidence,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status,assignedRole=excluded.assignedRole,
         assignedSessionId=excluded.assignedSessionId,workspaceId=excluded.workspaceId,
         attempts=excluded.attempts,evidence=excluded.evidence,updatedAt=excluded.updatedAt`, task.id, task.runId, task.type, task.title, task.description ?? null, task.status, task.priority, task.dependencies, task.assignedRole ?? null, task.assignedSessionId ?? null, task.workspaceId ?? null, task.inputArtifactIds, task.acceptanceCriteria, task.limits, task.idempotencyKey, task.attempts, task.evidence, task.createdAt, task.updatedAt);
    }
    async getTask(id) {
        return this.req().get("SELECT * FROM tasks WHERE id = ?", id);
    }
    async listTasksByRun(runId) {
        return this.req().all("SELECT * FROM tasks WHERE runId = ? ORDER BY createdAt", runId);
    }
    async listTasksByStatus(statuses) {
        if (statuses.length === 0)
            return [];
        const ph = statuses.map(() => "?").join(",");
        return this.req().all(`SELECT * FROM tasks WHERE status IN (${ph})`, ...statuses);
    }
    // ── Event journal (append-only, sequenced, deduped) ────────────────────────
    async appendEvent(evt) {
        const db = this.req();
        // Dedup: same (type, correlationId, payload) already recorded → return existing (idempotency).
        if (evt.correlationId) {
            const existing = db.get("SELECT * FROM events WHERE type=? AND correlationId=? AND payload=? LIMIT 1", evt.type, evt.correlationId, evt.payload);
            if (existing)
                return existing;
        }
        db.run(`INSERT INTO events (type,runId,taskId,agentRunId,correlationId,schemaVersion,payload,at)
       VALUES (?,?,?,?,?,?,?,?)`, evt.type, evt.runId ?? null, evt.taskId ?? null, evt.agentRunId ?? null, evt.correlationId ?? null, evt.schemaVersion, evt.payload, evt.at);
        const seq = db.get("SELECT last_insert_rowid() AS seq")?.seq ?? 0;
        return { ...evt, seq };
    }
    async listEvents(filter) {
        const db = this.req();
        const where = [];
        const params = [];
        if (filter?.runId) {
            where.push("runId = ?");
            params.push(filter.runId);
        }
        if (filter?.sinceSeq !== undefined) {
            where.push("seq > ?");
            params.push(filter.sinceSeq);
        }
        const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq ASC${filter?.limit ? " LIMIT " + filter.limit : ""}`;
        return db.all(sql, ...params);
    }
    async lastSeq() {
        return this.req().get("SELECT COALESCE(MAX(seq),0) AS seq FROM events")?.seq ?? 0;
    }
    // ── Approvals ──────────────────────────────────────────────────────────────
    async putApproval(a) {
        const db = this.req();
        db.run(`INSERT INTO approvals (id,runId,taskId,action,resource,requestedBy,reason,status,decidedBy,decidedAt,expiresAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status,decidedBy=excluded.decidedBy,
         decidedAt=excluded.decidedAt`, a.id, a.runId, a.taskId ?? null, a.action, a.resource, a.requestedBy, a.reason, a.status, a.decidedBy ?? null, a.decidedAt ?? null, a.expiresAt ?? null);
    }
    async getApproval(id) {
        return this.req().get("SELECT * FROM approvals WHERE id = ?", id);
    }
    async listApprovalsByRun(runId) {
        return this.req().all("SELECT * FROM approvals WHERE runId = ?", runId);
    }
    async listPendingApprovals() {
        return this.req().all("SELECT * FROM approvals WHERE status = 'pending'");
    }
    // ── Budget ─────────────────────────────────────────────────────────────────
    async putBudget(b) {
        const db = this.req();
        db.run(`INSERT INTO budgets (runId,maxConcurrentWorkers,maxAttemptsPerTask,maxTotalSeconds,maxEstimatedCostUsd,maxModelCalls,usedModelCalls,usedEstimatedCostUsd,startedAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(runId) DO UPDATE SET maxConcurrentWorkers=excluded.maxConcurrentWorkers,
         maxAttemptsPerTask=excluded.maxAttemptsPerTask,maxTotalSeconds=excluded.maxTotalSeconds,
         maxEstimatedCostUsd=excluded.maxEstimatedCostUsd,maxModelCalls=excluded.maxModelCalls,
         usedModelCalls=excluded.usedModelCalls,usedEstimatedCostUsd=excluded.usedEstimatedCostUsd,
         updatedAt=excluded.updatedAt`, b.runId, b.maxConcurrentWorkers, b.maxAttemptsPerTask, b.maxTotalSeconds, b.maxEstimatedCostUsd ?? null, b.maxModelCalls ?? null, b.usedModelCalls, b.usedEstimatedCostUsd, b.startedAt, b.updatedAt);
    }
    async getBudget(runId) {
        return this.req().get("SELECT * FROM budgets WHERE runId = ?", runId);
    }
    async updateBudget(runId, patch) {
        const cur = await this.getBudget(runId);
        if (!cur)
            throw new StorageError(`No budget for run ${runId}`);
        await this.putBudget({ ...cur, ...patch, runId, updatedAt: Date.now() });
    }
    // ── Leases (FR-054) ────────────────────────────────────────────────────────
    async acquireLease(taskId, owner, ttlMs) {
        const db = this.req();
        const now = Date.now();
        // Expire stale leases first so a dead owner doesn't block forever.
        db.run("DELETE FROM leases WHERE expiresAt <= ?", now);
        const held = db.get("SELECT * FROM leases WHERE taskId = ?", taskId);
        if (held)
            return false; // someone else owns it and hasn't expired
        db.run("INSERT INTO leases (taskId,owner,acquiredAt,expiresAt) VALUES (?,?,?,?)", taskId, owner, now, now + ttlMs);
        return true;
    }
    async releaseLease(taskId, owner) {
        this.req().run("DELETE FROM leases WHERE taskId = ? AND owner = ?", taskId, owner);
    }
    async getLease(taskId) {
        return this.req().get("SELECT * FROM leases WHERE taskId = ?", taskId);
    }
    async expireLeases(now) {
        const before = this.req().get("SELECT COUNT(*) AS n FROM leases WHERE expiresAt <= ?", now)?.n ?? 0;
        this.req().run("DELETE FROM leases WHERE expiresAt <= ?", now);
        return before;
    }
    // ── Agent runs ─────────────────────────────────────────────────────────────
    async putAgentRun(a) {
        const db = this.req();
        db.run(`INSERT INTO agent_runs (id,runId,taskId,role,sessionId,status,workspaceId,model,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status,sessionId=excluded.sessionId,
         workspaceId=excluded.workspaceId,updatedAt=excluded.updatedAt`, a.id, a.runId, a.taskId, a.role, a.sessionId ?? null, a.status, a.workspaceId ?? null, a.model ?? null, a.createdAt, a.updatedAt);
    }
    async getAgentRun(id) {
        return this.req().get("SELECT * FROM agent_runs WHERE id = ?", id);
    }
    async listAgentRunsByRun(runId) {
        return this.req().all("SELECT * FROM agent_runs WHERE runId = ?", runId);
    }
    async findAgentRunBySession(sessionId) {
        return this.req().get("SELECT * FROM agent_runs WHERE sessionId = ?", sessionId);
    }
    // ── Retention / integrity ──────────────────────────────────────────────────
    async purgeRunsOlderThan(cutoffMs) {
        const db = this.req();
        const doomed = db
            .all("SELECT id FROM runs WHERE updatedAt < ? AND status IN ('CLOSED','CANCELLED','FAILED','REJECTED')", cutoffMs)
            .map((r) => r.id);
        if (doomed.length === 0)
            return 0;
        db.transaction(() => {
            for (const id of doomed) {
                db.run("DELETE FROM tasks WHERE runId = ?", id);
                db.run("DELETE FROM events WHERE runId = ?", id);
                db.run("DELETE FROM approvals WHERE runId = ?", id);
                db.run("DELETE FROM budgets WHERE runId = ?", id);
                db.run("DELETE FROM agent_runs WHERE runId = ?", id);
                db.run("DELETE FROM runs WHERE id = ?", id);
            }
        });
        return doomed.length;
    }
    async verifyIntegrity() {
        const issues = [];
        const db = this.req();
        const sv = db.get("SELECT value FROM meta WHERE key='schemaVersion'");
        if (!sv || Number(sv.value) !== SCHEMA_VERSION)
            issues.push("schemaVersion mismatch or missing");
        // Orphan tasks (task.runId with no run)
        const orphanTasks = db.get("SELECT COUNT(*) AS n FROM tasks t LEFT JOIN runs r ON t.runId=r.id WHERE r.id IS NULL")?.n;
        if ((orphanTasks ?? 0) > 0)
            issues.push(`${orphanTasks} orphan task(s) with missing run`);
        // Event seq continuity is not required (append-only can have gaps after purge), but
        // negative or zero seq indicates corruption.
        const badEvents = db.get("SELECT COUNT(*) AS n FROM events WHERE seq <= 0")?.n;
        if ((badEvents ?? 0) > 0)
            issues.push(`${badEvents} event(s) with non-positive seq`);
        return { ok: issues.length === 0, issues };
    }
}
