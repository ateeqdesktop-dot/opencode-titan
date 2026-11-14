const BLUEPRINT = [
    {
        type: "exploration",
        title: "Explore existing code relevant to the goal",
        describe: (g) => `Understand the parts of the codebase that matter for the goal: ${g}`,
    },
    {
        type: "planning",
        title: "Turn the goal into a concrete implementation plan",
        describe: (g) => `Produce a precise, minimal plan to achieve: ${g}`,
    },
    {
        type: "implementation",
        title: "Implement the plan",
        describe: (g) => `Implement the planned changes for: ${g}`,
    },
    {
        type: "test",
        title: "Test the implementation",
        describe: (g) => `Add/adjust tests covering the implementation for: ${g}`,
    },
    {
        type: "review",
        title: "Review implementation and tests",
        describe: (g) => `Adversarially review the implementation and tests for: ${g}`,
    },
    {
        type: "integration",
        title: "Integrate results and produce the final report",
        describe: (g) => `Pull the accepted results together for: ${g}; state what changed.`,
    },
];
export function runBlueprint(goal) {
    return BLUEPRINT.map((step, i) => ({
        type: step.type,
        title: step.title,
        description: step.describe(goal),
        ...(i > 0 ? { dependencies: [`#${i - 1}`] } : {}),
    }));
}
export function renderRunStatus(view, activeWorkers) {
    const { run, tasks, dag } = view;
    const header = `Run ${run.id} — ${run.status}${run.statusReason ? ` (${run.statusReason})` : ""} — ${dag.percent}%`;
    const goal = `Goal: ${run.goal}`;
    const counts = [
        `done ${dag.succeeded}`,
        `failed ${dag.failed}`,
        `skipped ${dag.skipped}`,
        `in-flight ${dag.running}`,
        `queued ${dag.pending}`,
        `of ${dag.total}`,
    ].join(", ");
    const workers = `Workers active: ${activeWorkers}`;
    const lines = [header, goal, `Tasks: ${counts}`, workers, ...tasks.map((t) => `  [${t.status}] ${t.id} ${t.title}`)];
    return lines.join("\n");
}
