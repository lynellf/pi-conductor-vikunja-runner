import type { ProjectConfig } from "../config/config.js";
import type { CodingTask, TaskComment, UserId } from "./types.js";

/** A task with the optional description returned by Vikunja's task endpoint. */
export interface PromptTask extends CodingTask {
  readonly description?: string;
}

export interface ConductorGoalInput {
  readonly task: PromptTask;
  readonly project: ProjectConfig;
  readonly branch: string;
  readonly comments: readonly TaskComment[];
  readonly ownerUserId: UserId;
  readonly runnerUserId: UserId;
  /** Maximum characters reserved for task and comment content. */
  readonly maxInputChars?: number;
  /** Retry prompts may retain runner comments that contain useful context. */
  readonly includeRunnerComments?: boolean;
}

const DEFAULT_MAX_INPUT_CHARS = 12_000;

const boundedInput = (value: string, max: number): string =>
  value.length <= max ? value : value.slice(0, max);

const repositoryName = (repository: string): string => {
  const withoutSuffix = repository.replace(/\/+$/, "").replace(/\.git$/, "");
  const name = withoutSuffix.split(/[/:]/).at(-1);
  return name && name.length > 0 ? name : "configured repository";
};

const orderedComments = (
  comments: readonly TaskComment[],
  ownerUserId: UserId,
  runnerUserId: UserId,
  includeRunnerComments: boolean,
): readonly TaskComment[] =>
  comments
    .filter(
      (comment) =>
        comment.authorId === ownerUserId ||
        (includeRunnerComments && comment.authorId === runnerUserId),
    )
    .toSorted((left, right) => {
      const created = left.createdAt.localeCompare(right.createdAt);
      return created !== 0 ? created : left.id - right.id;
    });

/** Build the deterministic, bounded Markdown goal passed to pi-conductor. */
export const buildConductorGoal = (input: ConductorGoalInput): string => {
  const maxInputChars = input.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  if (!Number.isSafeInteger(maxInputChars) || maxInputChars < 1) {
    throw new Error("maxInputChars must be a positive integer");
  }

  const comments = orderedComments(
    input.comments,
    input.ownerUserId,
    input.runnerUserId,
    input.includeRunnerComments ?? false,
  );
  const content = [
    `### Title\n${input.task.title}`,
    `### Description\n${input.task.description ?? "(none provided)"}`,
    ...(comments.length === 0
      ? ["### Owner comments\n(none)"]
      : [
          "### Owner comments (chronological)",
          ...comments.map(
            (comment) =>
              `- ${comment.createdAt} [comment ${comment.id}]\n  ${comment.body}`,
          ),
        ]),
  ].join("\n\n");
  const boundedContent =
    content.length <= maxInputChars
      ? content
      : `${boundedInput(content, maxInputChars)}\n[task input truncated]`;
  const reference = `${input.project.displayIdentifier}-${input.task.id}`;
  const verificationCommands = input.project.verifyCommands
    .map((command) => `  - \`${command.join(" ")}\``)
    .join("\n");

  return `# Coding task ${reference}

Work on **${reference}** in the supplied worktree.

## Task input

${boundedContent}

## Repository

- Repository: ${repositoryName(input.project.repository)}
- Task branch: ${input.branch}
- Default branch: ${input.project.defaultBranch}
- Conductor manifest: ${input.project.conductorManifest}

## Working rules

- Work only in the supplied worktree and leave a reviewable, clean worktree.
- Run every configured project verification check before completing:
${verificationCommands}
- Use \`ask_user\` for any decision that requires the owner's input.
- Do not merge, deploy, or force-push. Do not modify runner configuration or read runner secrets.
`;
};
