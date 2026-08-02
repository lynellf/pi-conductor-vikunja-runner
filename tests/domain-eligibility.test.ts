import { describe, expect, it } from "vitest";
import { selectEligibleTasks } from "../src/domain/eligibility.js";
import { validateProjectLayout } from "../src/domain/layout.js";
import {
  type Bucket,
  bucketId,
  type CodingTask,
  type ProjectLayout,
  projectId,
  taskId,
  viewId,
} from "../src/domain/types.js";

const makeLayout = (project: number): [number, ProjectLayout] => {
  const buckets: Bucket[] = [
    "Backlog",
    "Ready",
    "Running",
    "Waiting",
    "Review",
    "Failed",
    "Done",
  ].map((title, index) => ({
    id: bucketId(project * 10 + index + 1),
    title,
    position: index,
  }));
  return [
    project,
    validateProjectLayout(
      viewId(project),
      buckets,
      bucketId(project * 10 + 1),
      bucketId(project * 10 + 7),
    ),
  ];
};

const task = (
  id: number,
  project: number,
  priority: number,
  position: number,
  bucket: number,
  done = false,
): CodingTask => ({
  id: taskId(id),
  projectId: projectId(project),
  title: `Task ${id}`,
  priority,
  position,
  bucketId: bucketId(bucket),
  done,
});

describe("selectEligibleTasks", () => {
  it("ignores unconfigured projects, non-Ready buckets, done tasks, and active tasks", () => {
    const [project, layout] = makeLayout(42);
    const ready = layout.buckets.Ready.id;
    const running = layout.buckets.Running.id;

    const result = selectEligibleTasks(
      [
        task(1, project, 1, 1, ready),
        task(2, 999, 9, 1, ready),
        task(3, project, 9, 1, running),
        task(4, project, 9, 1, ready, true),
        task(5, project, 9, 1, ready),
      ],
      {
        layouts: new Map([[projectId(project), layout]]),
        activeTaskIds: new Set([taskId(5)]),
        availableSlots: 10,
      },
    );

    expect(result.map((candidate) => candidate.id)).toEqual([taskId(1)]);
  });

  it("orders by priority descending, position ascending, then task ID ascending", () => {
    const [project, layout] = makeLayout(42);
    const ready = layout.buckets.Ready.id;
    const result = selectEligibleTasks(
      [
        task(30, project, 2, 1, ready),
        task(20, project, 3, 4, ready),
        task(10, project, 3, 2, ready),
        task(11, project, 3, 2, ready),
      ],
      {
        layouts: new Map([[projectId(project), layout]]),
        activeTaskIds: new Set(),
        availableSlots: 10,
      },
    );

    expect(result.map((candidate) => candidate.id)).toEqual([
      taskId(10),
      taskId(11),
      taskId(20),
      taskId(30),
    ]);
  });

  it("limits selection to the available global concurrency slots", () => {
    const [project, layout] = makeLayout(42);
    const ready = layout.buckets.Ready.id;
    const result = selectEligibleTasks(
      [task(1, project, 2, 1, ready), task(2, project, 1, 1, ready)],
      {
        layouts: new Map([[projectId(project), layout]]),
        activeTaskIds: new Set(),
        availableSlots: 1,
      },
    );

    expect(result.map((candidate) => candidate.id)).toEqual([taskId(1)]);
  });
});
