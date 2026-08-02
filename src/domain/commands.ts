import type { UserId } from "./types.js";

/** Parsed owner-authored control or task comment. Spec §11.2. */
export type PiCommentAction =
  | { readonly kind: "ignore"; readonly reason: "not-owner" }
  | { readonly kind: "plain"; readonly body: string }
  | { readonly kind: "steer"; readonly message: string }
  | { readonly kind: "abort"; readonly reason: string | null }
  | { readonly kind: "help"; readonly message: string };

export const PI_COMMAND_HELP =
  "Supported commands: /pi steer <message> or /pi abort [reason].";

/**
 * Parse one comment without performing a side effect. Only the configured
 * owner can produce a control action; callers decide whether plain comments
 * are answers, retry context, or no-op content based on the current job state.
 */
export const parsePiComment = (
  body: string,
  authorId: UserId,
  ownerUserId: UserId,
): PiCommentAction => {
  if (authorId !== ownerUserId) {
    return { kind: "ignore", reason: "not-owner" };
  }

  const comment = body.trim();
  if (!comment.startsWith("/pi")) {
    return { kind: "plain", body };
  }

  const match = /^\/pi(?:\s+([a-z]+)(?:\s+(.*))?)?$/u.exec(comment);
  const command = match?.[1];
  const argument = match?.[2]?.trim() ?? "";
  if (command === "steer" && argument !== "") {
    return { kind: "steer", message: argument };
  }
  if (command === "abort") {
    return { kind: "abort", reason: argument === "" ? null : argument };
  }
  return { kind: "help", message: PI_COMMAND_HELP };
};
