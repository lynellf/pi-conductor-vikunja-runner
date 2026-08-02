import { describe, expect, it, vi } from "vitest";
import { createJsonLogger, redactLogText } from "../src/cli/logging.js";

describe("structured runner logging", () => {
  it("emits one JSON object with a timestamp, level, event, and context", () => {
    const write = vi.fn();
    const logger = createJsonLogger(write);

    logger.info("runner_started", { projectId: 42, cycles: 1 });

    expect(write).toHaveBeenCalledTimes(1);
    const record = JSON.parse(write.mock.calls[0]?.[0] ?? "") as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({
      level: "info",
      event: "runner_started",
      projectId: 42,
      cycles: 1,
    });
    expect(record.timestamp).toEqual(expect.any(String));
  });

  it("redacts authorization and token-shaped values from errors", () => {
    expect(
      redactLogText(
        "request failed Authorization: Bearer top-secret token=abc123 password=hunter2",
      ),
    ).toBe(
      "request failed Authorization: [REDACTED] token=[REDACTED] password=[REDACTED]",
    );
  });
});
