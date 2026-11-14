/**
 * Recovery (SRS §10.2, §12.2, FR-090/091, FAULT-01..08).
 *
 * On OpenCode restart, TITAN must:
 *  - Load Event Journal + persisted Run/Task state.
 *  - Validate integrity (orphans, schema version).
 *  - Reconcile leases: expire stale ones; a task still "RUNNING" with no live
 *    lease is ambiguous → mark NEEDS_RECONCILIATION (never assume success).
 *  - Resume only provably-safe work (READY/QUEUED tasks whose deps are met).
 *  - Never auto-spend: budget exhaustion keeps the run paused/resumable.
 *
 * This module is pure orchestration over `PersistenceAdapter` + `RunManager`.
 */
import { type PersistenceAdapter } from "./adapter.js";
import { RunManager } from "../application/run-manager.js";
export interface RecoveryReport {
    readonly runsScanned: number;
    readonly runsResumed: number;
    readonly tasksReconciled: number;
    readonly tasksMarkedNeedsReconciliation: number;
    readonly leasesExpired: number;
    readonly integrityIssues: string[];
    readonly errors: string[];
}
export interface RecoveryOptions {
    /** Tasks whose lease is older than this are considered stale. Default 5 min. */
    readonly staleLeaseMs?: number;
    /** Whether to auto-transition ambiguous RUNNING tasks to NEEDS_RECONCILIATION. Default true. */
    readonly reconcileAmbiguous?: boolean;
}
export declare function recover(adapter: PersistenceAdapter, runManager: RunManager, opts?: RecoveryOptions): Promise<RecoveryReport>;
