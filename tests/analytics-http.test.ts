import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistedRecord } from "pi-conductor";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnalyticsBridge,
  type AnalyticsRecordSubscriber,
} from "../src/conductor/analytics.js";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "runner-analytics-http-"));
  temporaryDirectories.push(path);
  return path;
};

const listen = async (received: unknown[]): Promise<string> => {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(204).end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test analytics server has no TCP address");
  }
  return `http://127.0.0.1:${address.port}/events`;
};

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) =>
              error === undefined ? resolve() : reject(error),
            ),
          ),
      ),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

class TestSubscriber implements AnalyticsRecordSubscriber {
  public listener: ((record: PersistedRecord) => void) | undefined;

  public subscribe(listener: (record: PersistedRecord) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
}

const records = [
  { type: "session_started", run_id: "run-1", ts: 1 },
  { type: "transition_accepted", run_id: "run-1", ts: 2 },
  { type: "checkpoint_snapshot", run_id: "run-1", ts: 3 },
  {
    type: "file_mutation",
    run_id: "run-1",
    role: "worker",
    session_id: "session-1",
    session_file: "/tmp/session.jsonl",
    tool_name: "edit",
    files: [{ path: "src/index.ts", additions: 1, deletions: 0 }],
    ts: 4,
  },
] as const;

describe("analytics HTTP compatibility", () => {
  it("delivers lifecycle, transition, checkpoint, and file mutation records unchanged", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const root = await temporaryDirectory();
    const runsDir = join(root, "conductor-runs");
    await mkdir(runsDir, { recursive: true });
    const received: unknown[] = [];
    const endpoint = await listen(received);
    const configPath = join(root, "analytics.json");
    await writeFile(
      configPath,
      JSON.stringify({
        endpoint,
        batch: { enabled: true, maxRecords: 4, flushIntervalMs: 10 },
        request: { timeoutMs: 1000, maxRetries: 0 },
      }),
    );
    const subscriber = new TestSubscriber();
    const bridge = new AnalyticsBridge({
      dataDir: root,
      runsDir,
      configPath,
      subscriber,
    });

    await bridge.start();
    for (const record of records) {
      subscriber.listener?.(record as unknown as PersistedRecord);
    }
    await bridge.shutdown();

    const delivered = received.flatMap((value) => {
      const envelope = value as { source?: unknown; records?: unknown[] };
      expect(envelope.source).toBe("pi.events:conductor:record");
      return envelope.records ?? [];
    });
    expect(delivered).toEqual(records);
  });

  it("replays an unsent JSONL record after an outage without advancing its watermark", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const root = await temporaryDirectory();
    const runsDir = join(root, "conductor-runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(
      join(runsDir, "run-outage.jsonl"),
      `${JSON.stringify(records[3])}\n`,
    );
    const configPath = join(root, "analytics.json");
    await writeFile(
      configPath,
      JSON.stringify({
        endpoint: "http://127.0.0.1:1/unavailable",
        batch: { enabled: true, maxRecords: 1, flushIntervalMs: 1 },
        request: { timeoutMs: 25, maxRetries: 0 },
      }),
    );

    const failedBridge = new AnalyticsBridge({
      dataDir: root,
      runsDir,
      configPath,
      subscriber: new TestSubscriber(),
    });
    await failedBridge.start();
    await failedBridge.shutdown();
    await expect(
      readFile(join(runsDir, "run-outage.watermark.json"), "utf8"),
    ).rejects.toThrow();

    const received: unknown[] = [];
    const endpoint = await listen(received);
    await writeFile(
      configPath,
      JSON.stringify({
        endpoint,
        batch: { enabled: true, maxRecords: 1, flushIntervalMs: 1 },
        request: { timeoutMs: 1000, maxRetries: 0 },
      }),
    );
    const recoveredBridge = new AnalyticsBridge({
      dataDir: root,
      runsDir,
      configPath,
      subscriber: new TestSubscriber(),
    });
    await recoveredBridge.start();
    await recoveredBridge.shutdown();

    const delivered = received.flatMap(
      (value) => (value as { records?: unknown[] }).records ?? [],
    );
    expect(delivered).toEqual([records[3]]);
    await expect(
      readFile(join(runsDir, "run-outage.watermark.json"), "utf8"),
    ).resolves.toContain("lastSentIndex");
  });
});
