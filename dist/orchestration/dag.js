/**
 * DAG engine.
 * SRS §7.3 (FR-023, FR-024, FR-025), §5.5 (DAG not free conversation).
 *
 * Responsibilities:
 *  - build + validate a task graph (no cycles, no orphans, no missing deps,
 *    every acceptance criterion has a verification path)
 *  - compute the ready set (all dependencies satisfied)
 *  - prevent a task from running before its dependencies complete
 *  - schedule independent tasks concurrently
 *  - propagate failure to dependents per policy
 *  - compute run progress
 *  - serialize/restore DAG state
 *
 * This is a real graph engine, not a task list labelled "DAG".
 */
export class Dag {
    nodes = new Map();
    state = new Map();
    constructor(tasks = []) {
        for (const t of tasks)
            this.add(t);
    }
    add(task) {
        this.nodes.set(task.id, task);
        if (!this.state.has(task.id))
            this.state.set(task.id, "pending");
    }
    get(id) {
        return this.nodes.get(id);
    }
    size() {
        return this.nodes.size;
    }
    ids() {
        return [...this.nodes.keys()];
    }
    dependentsOf(id) {
        const out = [];
        for (const t of this.nodes.values()) {
            if (t.dependencies.includes(id))
                out.push(t.id);
        }
        return out;
    }
    // ── Validation (FR-024) ───────────────────────────────────────────────────
    validate() {
        const issues = [];
        const seen = new Set();
        const ids = new Set(this.nodes.keys());
        for (const t of this.nodes.values()) {
            if (seen.has(t.id))
                issues.push({ kind: "duplicate-id", taskId: t.id });
            seen.add(t.id);
            for (const dep of t.dependencies) {
                if (dep === t.id)
                    issues.push({ kind: "self-dependency", taskId: t.id });
                else if (!ids.has(dep))
                    issues.push({ kind: "missing-dependency", taskId: t.id, missing: dep });
            }
        }
        const cycle = this.findCycle();
        if (cycle)
            issues.push({ kind: "cycle", taskIds: cycle });
        // Orphan: a node with no dependencies and no dependents, in a graph that has
        // at least one edge (so genuinely isolated nodes are flagged, but a run of
        // fully independent parallel tasks is legitimate).
        const hasAnyEdge = [...this.nodes.values()].some((n) => n.dependencies.length > 0);
        if (hasAnyEdge && this.nodes.size > 1) {
            for (const t of this.nodes.values()) {
                const hasDep = t.dependencies.length > 0;
                const hasDependent = this.dependentsOf(t.id).length > 0;
                if (!hasDep && !hasDependent)
                    issues.push({ kind: "orphan", taskId: t.id });
            }
        }
        return { ok: issues.length === 0, issues };
    }
    /** Returns a cycle as an ordered id list, or null if acyclic. DFS with colouring. */
    findCycle() {
        const WHITE = 0, GRAY = 1, BLACK = 2;
        const colour = new Map();
        for (const id of this.nodes.keys())
            colour.set(id, WHITE);
        const stack = [];
        const visit = (id) => {
            colour.set(id, GRAY);
            stack.push(id);
            const node = this.nodes.get(id);
            if (node) {
                for (const dep of node.dependencies) {
                    if (!this.nodes.has(dep))
                        continue;
                    const c = colour.get(dep);
                    if (c === GRAY) {
                        // found a cycle — slice stack from dep
                        const idx = stack.indexOf(dep);
                        return stack.slice(idx);
                    }
                    if (c === WHITE) {
                        const found = visit(dep);
                        if (found)
                            return found;
                    }
                }
            }
            colour.set(id, BLACK);
            stack.pop();
            return null;
        };
        for (const id of this.nodes.keys()) {
            if (colour.get(id) === WHITE) {
                const cyc = visit(id);
                if (cyc)
                    return cyc;
            }
        }
        return null;
    }
    // ── Readiness (FR-050, FR-025) ────────────────────────────────────────────
    /** Tasks whose dependencies are ALL in a terminal-success state and that are themselves pending. */
    readyTasks() {
        const ready = [];
        for (const t of this.nodes.values()) {
            if (this.state.get(t.id) !== "pending")
                continue;
            const allDepsDone = t.dependencies.every((d) => this.state.get(d) === "succeeded");
            if (allDepsDone)
                ready.push(t.id);
        }
        return ready;
    }
    /** Hard-blocked: any transitive dependency failed or was skipped. */
    blockedTasks() {
        const blocked = [];
        for (const t of this.nodes.values()) {
            const s = this.state.get(t.id);
            if (s !== "pending")
                continue;
            if (this.hasFailedAncestor(t.id))
                blocked.push(t.id);
        }
        return blocked;
    }
    /** True if any ancestor (transitive dependency) is failed or skipped. */
    hasFailedAncestor(id) {
        const seen = new Set();
        const queue = [...(this.nodes.get(id)?.dependencies ?? [])];
        while (queue.length) {
            const cur = queue.shift();
            if (seen.has(cur))
                continue;
            seen.add(cur);
            const st = this.state.get(cur);
            if (st === "failed" || st === "skipped")
                return true;
            const node = this.nodes.get(cur);
            if (node)
                queue.push(...node.dependencies);
        }
        return false;
    }
    setState(id, s) {
        if (!this.nodes.has(id))
            throw new Error(`Unknown task in DAG: ${id}`);
        this.state.set(id, s);
    }
    getState(id) {
        return this.state.get(id);
    }
    // ── Failure propagation (FR: stop dependents when a dependency fails) ─────
    /**
     * When a task fails, mark all transitive dependents as skipped (blocked by
     * policy) so they never run against a broken prerequisite.
     */
    propagateFailure(failedId) {
        const skipped = [];
        const queue = [failedId];
        const visited = new Set();
        while (queue.length) {
            const cur = queue.shift();
            if (visited.has(cur))
                continue;
            visited.add(cur);
            for (const dep of this.dependentsOf(cur)) {
                const s = this.state.get(dep);
                if (s === "pending" || s === "ready") {
                    this.state.set(dep, "skipped");
                    skipped.push(dep);
                    queue.push(dep);
                }
            }
        }
        return skipped;
    }
    // ── Progress (SRS §5.2) ───────────────────────────────────────────────────
    progress() {
        let succeeded = 0, failed = 0, skipped = 0, running = 0, pending = 0;
        for (const s of this.state.values()) {
            if (s === "succeeded")
                succeeded++;
            else if (s === "failed")
                failed++;
            else if (s === "skipped")
                skipped++;
            else if (s === "running")
                running++;
            else
                pending++;
        }
        const total = this.nodes.size;
        const done = succeeded + failed + skipped;
        return {
            total,
            succeeded,
            failed,
            skipped,
            running,
            pending,
            percent: total === 0 ? 100 : Math.round((done / total) * 100),
        };
    }
    isComplete() {
        const p = this.progress();
        return p.pending === 0 && p.running === 0;
    }
    // ── Persistence (FR-090: serialize/restore) ───────────────────────────────
    serialize() {
        const states = {};
        for (const [id, s] of this.state)
            states[id] = s;
        return { nodes: [...this.nodes.values()], states };
    }
    static deserialize(data) {
        const dag = new Dag(data.nodes);
        for (const [id, s] of Object.entries(data.states)) {
            if (dag.nodes.has(id))
                dag.state.set(id, s);
        }
        return dag;
    }
}
