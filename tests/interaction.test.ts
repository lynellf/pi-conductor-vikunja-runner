import { describe, expect, it } from "vitest";
import {
  type QuestionResponse,
  validateQuestionResponse,
} from "../src/domain/interaction.js";
import { jobId } from "../src/domain/jobs.js";
import { commentId, taskId, userId } from "../src/domain/types.js";
import type { Question } from "../src/persistence/contracts.js";
import { questionId } from "../src/persistence/contracts.js";

const question = (overrides: Partial<Question> = {}): Question => ({
  id: questionId("question-1"),
  jobId: jobId("job-1"),
  taskId: taskId(12),
  kind: "input",
  prompt: "What should I do?",
  options: [],
  commentWatermark: null,
  commentId: commentId(20),
  responseCommentId: null,
  answer: null,
  abortReason: null,
  state: "pending",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const response = (body: string, author = 1): QuestionResponse => ({
  authorId: userId(author),
  body,
});

describe("validateQuestionResponse", () => {
  it("accepts a non-empty owner input and trims it", () => {
    expect(
      validateQuestionResponse(
        question(),
        response("  use the cache  "),
        userId(1),
      ),
    ).toEqual({ ok: true, answer: "use the cache" });
  });

  it("rejects empty owner input", () => {
    expect(
      validateQuestionResponse(question(), response("   "), userId(1)),
    ).toEqual({
      ok: false,
      reason: "reply must not be empty",
    });
  });

  it("ignores runner and other-user comments", () => {
    expect(
      validateQuestionResponse(question(), response("answer", 2), userId(1)),
    ).toEqual({ ok: false, reason: "comment is not authored by the owner" });
  });

  it("accepts only yes/no variants for confirm questions", () => {
    const confirm = question({ kind: "confirm" });
    expect(validateQuestionResponse(confirm, response("Y"), userId(1))).toEqual(
      {
        ok: true,
        answer: "yes",
      },
    );
    expect(
      validateQuestionResponse(confirm, response("maybe"), userId(1)),
    ).toEqual({
      ok: false,
      reason: "reply with yes or no",
    });
  });

  it("accepts select option text or a one-based option number", () => {
    const select = question({ kind: "select", options: ["small", "large"] });
    expect(
      validateQuestionResponse(select, response("large"), userId(1)),
    ).toEqual({
      ok: true,
      answer: "large",
    });
    expect(validateQuestionResponse(select, response("1"), userId(1))).toEqual({
      ok: true,
      answer: "small",
    });
    expect(validateQuestionResponse(select, response("3"), userId(1))).toEqual({
      ok: false,
      reason: "reply with an option name or a one-based option number",
    });
  });
});
