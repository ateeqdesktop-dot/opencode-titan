import { describe, expect, test } from "bun:test"
import { Dag } from "../../src/orchestration/dag.js"

interface T {
  id: string
  dependencies: readonly string[]
}

const t = (id: string, deps: string[] = []): T => ({ id, dependencies: deps })

describe("DAG validation (FR-024)", () => {
  test("accepts a valid acyclic graph", () => {
    const dag = new Dag([t("a"), t("b", ["a"]), t("c", ["a"]), t("d", ["b", "c"])])
    const v = dag.validate()
    expect(v.ok).toBe(true)
    expect(v.issues).toHaveLength(0)
  })

  test("detects a cycle", () => {
    const dag = new Dag([t("a", ["c"]), t("b", ["a"]), t("c", ["b"])])
    const v = dag.validate()
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.kind === "cycle")).toBe(true)
  })

  test("detects self-dependency", () => {
    const dag = new Dag([t("a", ["a"])])
    const v = dag.validate()
    expect(v.issues.some((i) => i.kind === "self-dependency")).toBe(true)
  })

  test("detects missing dependency", () => {
    const dag = new Dag([t("a", ["ghost"])])
    const v = dag.validate()
    const issue = v.issues.find((i) => i.kind === "missing-dependency")
    expect(issue).toBeDefined()
    expect(issue && "missing" in issue && issue.missing).toBe("ghost")
  })

  test("detects orphan (disconnected node in multi-node graph)", () => {
    const dag = new Dag([t("a"), t("b", ["a"]), t("lonely")])
    const v = dag.validate()
    expect(v.issues.some((i) => i.kind === "orphan" && i.taskId === "lonely")).toBe(true)
  })

  test("single node graph has no orphan", () => {
    const dag = new Dag([t("only")])
    expect(dag.validate().ok).toBe(true)
  })
})

describe("DAG readiness (FR-050, FR-025)", () => {
  test("only tasks with all deps succeeded are ready", () => {
    const dag = new Dag([t("a"), t("b", ["a"]), t("c", ["a", "b"])])
    // initially only root `a` is ready
    expect(dag.readyTasks()).toEqual(["a"])

    dag.setState("a", "succeeded")
    // now b is ready (its only dep a succeeded), but c still waits on b
    expect(dag.readyTasks()).toEqual(["b"])

    dag.setState("b", "succeeded")
    expect(dag.readyTasks()).toEqual(["c"])
  })

  test("a running dependency keeps dependents from being ready", () => {
    const dag = new Dag([t("a"), t("b", ["a"])])
    dag.setState("a", "running")
    expect(dag.readyTasks()).toEqual([])
  })

  test("blocked tasks surface when a dependency failed", () => {
    const dag = new Dag([t("a"), t("b", ["a"]), t("c", ["b"])])
    dag.setState("a", "failed")
    const blocked = dag.blockedTasks()
    expect(blocked).toContain("b")
    expect(blocked).toContain("c")
  })
})

describe("DAG failure propagation", () => {
  test("failure marks transitive dependents skipped", () => {
    const dag = new Dag([t("a"), t("b", ["a"]), t("c", ["b"]), t("independent")])
    dag.setState("a", "failed")
    const skipped = dag.propagateFailure("a")
    expect(skipped).toEqual(expect.arrayContaining(["b", "c"]))
    expect(dag.getState("c")).toBe("skipped")
    // independent task unaffected
    expect(dag.getState("independent")).toBe("pending")
  })

  test("does not re-skip already-terminal dependents", () => {
    const dag = new Dag([t("a"), t("b", ["a"])])
    dag.setState("b", "succeeded")
    dag.setState("a", "failed")
    const skipped = dag.propagateFailure("a")
    expect(skipped).not.toContain("b")
    expect(dag.getState("b")).toBe("succeeded")
  })
})

describe("DAG progress & completion", () => {
  test("progress percentages", () => {
    const dag = new Dag([t("a"), t("b"), t("c"), t("d")])
    expect(dag.progress().percent).toBe(0)
    dag.setState("a", "succeeded")
    dag.setState("b", "succeeded")
    dag.setState("c", "failed")
    dag.setState("d", "skipped")
    const p = dag.progress()
    expect(p.total).toBe(4)
    expect(p.percent).toBe(100)
    expect(dag.isComplete()).toBe(true)
  })

  test("empty dag is complete", () => {
    expect(new Dag<T>([]).isComplete()).toBe(true)
    expect(new Dag<T>([]).progress().percent).toBe(100)
  })
})

describe("DAG serialization (FR-090)", () => {
  test("serialize/deserialize round-trip preserves nodes and states", () => {
    const dag = new Dag([t("a"), t("b", ["a"])])
    dag.setState("a", "succeeded")
    const data = dag.serialize()
    const restored = Dag.deserialize<T>(data)
    expect(restored.size()).toBe(2)
    expect(restored.getState("a")).toBe("succeeded")
    expect(restored.getState("b")).toBe("pending")
    expect(restored.get("b")?.dependencies).toEqual(["a"])
  })
})

describe("DAG scale (NFR-005: 100 tasks / 300 deps)", () => {
  test("validates and computes readiness on a large graph", () => {
    const tasks: T[] = []
    // Build a layered graph: 100 tasks, each depending on up to 4 earlier ones.
    for (let i = 0; i < 100; i++) {
      const deps: string[] = []
      for (let j = 1; j <= 4; j++) {
        const prev = i - j * 3
        if (prev >= 0) deps.push(`t${prev}`)
      }
      tasks.push(t(`t${i}`, deps))
    }
    const dag = new Dag(tasks)
    const v = dag.validate()
    expect(v.ok).toBe(true)
    expect(dag.size()).toBe(100)

    // Mark layer roots succeeded, ensure readiness advances
    dag.setState("t0", "succeeded")
    const ready = dag.readyTasks()
    expect(ready.length).toBeGreaterThan(0)
    expect(ready).not.toContain("t0")
  })
})
