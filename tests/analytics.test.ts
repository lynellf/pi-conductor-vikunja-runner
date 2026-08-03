import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { PersistedRecord } from "pi-conductor";
import type {
  AnalyticsReporter,
  QueueStats,
} from "pi-conductor-analytics-plugin";
import { describe, expect, it, vi } from "vitest";
import {
  AnalyticsBridge,
  type AnalyticsRecordSubscriber,
  type ProjectAnalyticsReporterOptions,
  startAnalyticsBridge,
} from "../src/conductor/analytics.js";
import { projectId } from "../src/domain/types.js";

const stats = (): QueueStats => ({
  enqueued: 0,
  delivered: 0,
  failed: 0,
  dropped: 0,
  pending: 0,
});

class FakeReporter implements AnalyticsReporter {
  public readonly records: unknown[] = [];
  public backfillCalls = 0;
  public shutdownCalls = 0;
  public failBackfill = false;
  public failShutdown = false;

  public enqueue(record: unknown): void {
    this.records.push(record);
  }

  public async backfill(): Promise<number> {
    this.backfillCalls += 1;
    if (this.failBackfill) throw new Error("endpoint unavailable");
    return 2;
  }

  public async flush(): Promise<void> {}

  public async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    if (this.failShutdown) throw new Error("shutdown timeout");
  }

  public stats(): QueueStats {
    return stats();
  }
}

class FakeSubscriber implements AnalyticsRecordSubscriber {
  public listener: ((record: PersistedRecord) => void) | undefined;
  public subscribeCalls = 0;
  public unsubscribeCalls = 0;

  public subscribe(listener: (record: PersistedRecord) => void): () => void {
    this.subscribeCalls += 1;
    this.listener = listener;
    return () => {
      this.unsubscribeCalls += 1;
      this.listener = undefined;
    };
  }
}

const record = {
  type: "file_mutation",
  run_id: "run-1",
  role: "worker",
  session_id: "session-1",
  session_file: "/tmp/session.jsonl",
  tool_name: "write",
  files: [],
  ts: 1,
} as const satisfies PersistedRecord;

describe("AnalyticsBridge", () => {
  it("routes each run through the configured project repository context", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runner-analytics-route-"));
    const firstReporter = new FakeReporter();
    const secondReporter = new FakeReporter();
    const created: ProjectAnalyticsReporterOptions[] = [];
    const subscriber = new FakeSubscriber();
    const firstRunsDir = join(dataDir, "conductor-runs", "42");
    await mkdir(firstRunsDir, { recursive: true });
    await writeFile(join(firstRunsDir, "run-1.jsonl"), "");

    const bridge = new AnalyticsBridge({
      dataDir,
      configPath: "/run/credentials/analytics.json",
      projects: [
        {
          id: projectId(42),
          repository: "https://github.com/lynellf/homepage.git",
        },
        {
          id: projectId(43),
          repository: "git@github.com:lynellf/run-ledger.git",
        },
      ],
      reporterFactory: (options) => {
        created.push(options);
        return options.projectId === projectId(42)
          ? firstReporter
          : secondReporter;
      },
      subscriber,
    });

    await bridge.start();
    subscriber.listener?.(record);
    await bridge.shutdown();

    expect(firstReporter.records).toEqual([record]);
    expect(firstReporter.records[0]).toBe(record);
    expect(secondReporter.records).toEqual([]);
    expect(firstReporter.backfillCalls).toBe(1);
    expect(secondReporter.backfillCalls).toBe(1);
    expect(created).toEqual([
      expect.objectContaining({
        projectId: projectId(42),
        runsDir: firstRunsDir,
      }),
      expect.objectContaining({
        projectId: projectId(43),
        runsDir: join(dataDir, "conductor-runs", "43"),
      }),
    ]);
    expect(basename(created[0]?.cwd ?? "")).toBe("homepage");
    expect(basename(created[1]?.cwd ?? "")).toBe("run-ledger");
  });

  it("backfills then forwards live records unchanged and shuts down once", async () => {
    const reporter = new FakeReporter();
    const subscriber = new FakeSubscriber();
    const bridge = new AnalyticsBridge({
      dataDir: "/var/lib/runner",
      configPath: "/run/credentials/analytics.json",
      reporter,
      subscriber,
    });

    await bridge.start();
    subscriber.listener?.(record);
    await bridge.shutdown();
    await bridge.shutdown();

    expect(reporter.backfillCalls).toBe(1);
    expect(reporter.records).toEqual([record]);
    expect(reporter.records[0]).toBe(record);
    expect(subscriber.subscribeCalls).toBe(1);
    expect(subscriber.unsubscribeCalls).toBe(1);
    expect(reporter.shutdownCalls).toBe(1);
  });

  it("keeps the subscription alive when backfill and shutdown report failures", async () => {
    const reporter = new FakeReporter();
    reporter.failBackfill = true;
    reporter.failShutdown = true;
    const subscriber = new FakeSubscriber();
    const warn = vi.fn();
    const bridge = new AnalyticsBridge({
      dataDir: "/var/lib/runner",
      configPath: "/run/credentials/analytics.json",
      reporter,
      subscriber,
      logger: { warn, info: vi.fn() },
    });

    await expect(bridge.start()).resolves.toBeUndefined();
    subscriber.listener?.(record);
    await expect(bridge.shutdown()).resolves.toBeUndefined();

    expect(reporter.records).toEqual([record]);
    expect(subscriber.subscribeCalls).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      "analytics backfill failed",
      expect.objectContaining({ error: "Error" }),
    );
    expect(warn).toHaveBeenCalledWith(
      "analytics shutdown failed",
      expect.objectContaining({ error: "Error" }),
    );
  });

  it("returns a started bridge and isolates a synchronous enqueue failure", async () => {
    const enqueue = vi.fn(() => {
      throw new Error("queue closed");
    });
    const reporter = {
      enqueue,
      backfill: vi.fn(async () => 0),
      flush: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
      stats: vi.fn(stats),
    } satisfies AnalyticsReporter;
    const subscriber = new FakeSubscriber();
    const warn = vi.fn();
    const bridge = await startAnalyticsBridge({
      dataDir: "/var/lib/runner",
      configPath: "/run/credentials/analytics.json",
      reporter,
      subscriber,
      logger: { warn, info: vi.fn() },
    });

    subscriber.listener?.(record);
    await bridge.shutdown();

    expect(enqueue).toHaveBeenCalledWith(record);
    expect(warn).toHaveBeenCalledWith(
      "analytics enqueue failed",
      expect.objectContaining({ error: "Error" }),
    );
  });
});
