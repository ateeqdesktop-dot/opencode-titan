/**
 * Deterministic run blueprint (SRS §7.1 task lifecycle; FR-011 plan command).
 *
 * R3 scope: the plan is derived from the standard engineering playbook —
 * explore → plan → implement → test → review → integrate — with roles selected
 * by `AgentRegistry.selectFor` at scheduling time. Model-assisted planning and
 * per-goal refinement arrive in R4; this keeps planning honest, reviewable, and
 * independent of model latency (NFR-006).
 */
import type { CreateTaskInput } from "./run-manager.js";
import { type Run, type Task } from "../domain/types.js";
export interface BlueprintStep {
    readonly type: CreateTaskInput["type"];
    readonly title: string;
    readonly describe: (goal: string) => string;
}
export declare function runBlueprint(goal: string): CreateTaskInput[];
export interface RunProgressView {
    readonly run: Run;
    readonly tasks: readonly Task[];
    readonly dag: {
        readonly total: number;
        readonly succeeded: number;
        readonly failed: number;
        readonly skipped: number;
        readonly running: number;
        readonly pending: number;
        readonly percent: number;
    };
}
export declare function renderRunStatus(view: RunProgressView, activeWorkers: number): string;
