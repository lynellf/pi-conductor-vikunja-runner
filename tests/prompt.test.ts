import { describe, expect, it } from "vitest";
import { type ProjectConfig, parseConfig } from "../src/config/config.js";
import { buildConductorGoal, type PromptTask } from "../src/domain/prompt.js";
import { commentId, projectId, taskId, userId } from "../src/domain/types.js";

const project = (): ProjectConfig =>
  parseConfig({
    version: 1,
    vikunja: {
      base_url: "https://vikunja.example",
      token_file: "/run/token",
      owner_user_id: 1,
      runner_user_id: 2,
      poll_interval_seconds: 30,
      waiting_poll_interval_seconds: 15,
      request_timeout_seconds: 10,
      allow_insecure_http: false,
    },
    runner: {
      data_dir: "/var/lib/runner",
      global_concurrency: 1,
      agent_dir: "/var/lib/runner/pi-agent",
      conductor_manifest: "/operator/.pi/conductor.yaml",
      analytics_config_path: "/run/analytics.json",
      max_comment_chars: 12000,
    },
    projects: {
      "42": {
        display_identifier: "PC",
        kanban_view_id: 8,
        repository: "git@github.com:owner/repository.git",
        default_branch: "main",
        publish: { mode: "local", remote: "origin" },
        verify_commands: [["pnpm", "test"]],
      },
    },
  }).projects["42"] as ProjectConfig;

const task: PromptTask = {
  id: taskId(12),
  projectId: projectId(42),
  title: "Implement the thing",
  description: "A detailed description.",
  priority: 1,
  position: 1,
  bucketId: 2 as PromptTask["bucketId"],
  done: false,
};

describe("buildConductorGoal", () => {
  it("renders the task, repository, human comments, and safety instructions deterministically", () => {
    const goal = buildConductorGoal({
      task,
      project: project(),
      branch: "pi/vikunja-12-implement-the-thing",
      comments: [
        {
          id: commentId(2),
          taskId: task.id,
          authorId: userId(1),
          body: "Second owner note",
          createdAt: "2026-01-02T00:00:00.000Z",
        },
        {
          id: commentId(1),
          taskId: task.id,
          authorId: userId(2),
          body: "Runner milestone",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: commentId(3),
          taskId: task.id,
          authorId: userId(1),
          body: "First owner note",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      ownerUserId: userId(1),
      runnerUserId: userId(2),
    });

    expect(goal).toContain("PC-12");
    expect(goal).toContain("repository");
    expect(goal).toContain("pi/vikunja-12-implement-the-thing");
    expect(goal).toContain("repository");
    expect(goal).toContain("Second owner note");
    expect(goal).toContain("First owner note");
    expect(goal).not.toContain("Runner milestone");
    expect(goal).toContain(
      "Run every configured project verification check before completing:",
    );
    expect(goal).toContain("`pnpm test`");
    expect(goal).toContain("Use `ask_user`");
    expect(goal).toContain("Do not merge, deploy, or force-push");
    expect(goal.indexOf("First owner note")).toBeLessThan(
      goal.indexOf("Second owner note"),
    );
  });

  it("includes runner comments only when explicitly building a retry prompt", () => {
    const goal = buildConductorGoal({
      task,
      project: project(),
      branch: "pi/vikunja-12-retry",
      comments: [
        {
          id: commentId(1),
          taskId: task.id,
          authorId: userId(2),
          body: "Runner context for retry",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      ownerUserId: userId(1),
      runnerUserId: userId(2),
      includeRunnerComments: true,
    });

    expect(goal).toContain("Runner context for retry");
  });

  it("bounds untrusted task input and records that truncation occurred", () => {
    const goal = buildConductorGoal({
      task: { ...task, description: "x".repeat(200) },
      project: project(),
      branch: "pi/vikunja-12-task",
      comments: [],
      ownerUserId: userId(1),
      runnerUserId: userId(2),
      maxInputChars: 80,
    });

    expect(goal).toContain("[task input truncated]");
    expect(goal).not.toContain("x".repeat(200));
  });
});
