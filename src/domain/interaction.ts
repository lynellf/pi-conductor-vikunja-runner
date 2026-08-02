import type { Question } from "../persistence/contracts.js";
import type { UserId } from "./types.js";

/** Minimal owner comment input used to resolve a durable Vikunja question. */
export interface QuestionResponse {
  readonly authorId: UserId;
  readonly body: string;
}

export type QuestionValidation =
  | { readonly ok: true; readonly answer: string }
  | { readonly ok: false; readonly reason: string };

/** Validate one owner reply without changing durable state. Spec §11.1. */
export const validateQuestionResponse = (
  question: Question,
  response: QuestionResponse,
  ownerUserId: UserId,
): QuestionValidation => {
  if (response.authorId !== ownerUserId) {
    return { ok: false, reason: "comment is not authored by the owner" };
  }
  const answer = response.body.trim();
  if (answer === "") return { ok: false, reason: "reply must not be empty" };

  if (question.kind === "input") return { ok: true, answer };

  if (question.kind === "confirm") {
    const normalized = answer.toLowerCase();
    if (normalized === "yes" || normalized === "y") {
      return { ok: true, answer: "yes" };
    }
    if (normalized === "no" || normalized === "n") {
      return { ok: true, answer: "no" };
    }
    return { ok: false, reason: "reply with yes or no" };
  }

  const optionIndex = Number(answer);
  if (
    Number.isInteger(optionIndex) &&
    optionIndex >= 1 &&
    optionIndex <= question.options.length
  ) {
    const option = question.options[optionIndex - 1];
    if (option !== undefined) return { ok: true, answer: option };
  }
  if (question.options.includes(answer)) return { ok: true, answer };
  return {
    ok: false,
    reason: "reply with an option name or a one-based option number",
  };
};
