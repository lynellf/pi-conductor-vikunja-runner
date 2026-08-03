import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { type PersistedRecord, subscribeToRecords } from "pi-conductor";
import {
  type AnalyticsReporter,
  type AnalyticsReporterOptions,
  createAnalyticsReporter,
  type OverflowCallback,
} from "pi-conductor-analytics-plugin";
import type { ProjectId } from "../domain/types.js";

export interface AnalyticsLogger {
  readonly warn: (
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) => void;
  readonly info: (
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) => void;
}

export interface AnalyticsRecordSubscriber {
  subscribe(listener: (record: PersistedRecord) => void): () => void;
}

export const ANALYTICS_SOURCE = "pi.events:conductor:record";

export interface AnalyticsBridgeOptions {
  readonly dataDir: string;
  readonly runsDir?: string;
  readonly configPath: string;
  readonly source?: string;
  readonly projects?: readonly ProjectAnalyticsProject[];
  readonly reporter?: AnalyticsReporter;
  readonly reporterFactory?: ProjectAnalyticsReporterFactory;
  readonly subscriber?: AnalyticsRecordSubscriber;
  readonly logger?: AnalyticsLogger;
}

export interface ProjectAnalyticsProject {
  readonly id: ProjectId;
  readonly repository: string;
}

export interface ProjectAnalyticsReporterOptions {
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly runsDir: string;
}

export type ProjectAnalyticsReporterFactory = (
  options: ProjectAnalyticsReporterOptions,
  overflow: OverflowCallback,
) => AnalyticsReporter;

const noopLogger: AnalyticsLogger = {
  warn: () => undefined,
  info: () => undefined,
};

const defaultSubscriber: AnalyticsRecordSubscriber = {
  subscribe: (listener) => subscribeToRecords(listener),
};

const defaultReporter = (
  options: AnalyticsBridgeOptions,
  context: Pick<ProjectAnalyticsReporterOptions, "cwd" | "runsDir">,
  overflow: OverflowCallback,
): AnalyticsReporter => {
  const reporterOptions: AnalyticsReporterOptions = {
    cwd: context.cwd,
    runsDir: context.runsDir,
    configPath: options.configPath,
    source: options.source ?? ANALYTICS_SOURCE,
  };
  return createAnalyticsReporter(reporterOptions, overflow);
};

interface ProjectReporter {
  readonly projectId: ProjectId;
  readonly runsDir: string;
  readonly reporter: AnalyticsReporter;
}

const repositoryName = (repository: string, projectId: ProjectId): string => {
  const withoutSuffix = repository.replace(/\/+$/, "").replace(/\.git$/, "");
  const name = basename(withoutSuffix.replace(/\\/g, "/"));
  return name === "" || name === "." || name === ".."
    ? `project-${projectId}`
    : name;
};

const runIdOf = (record: PersistedRecord): string =>
  record.type === "checkpoint_snapshot"
    ? record.checkpoint.run_id
    : record.run_id;

/**
 * Own the daemon-wide analytics reporter and record subscription. Spec §13.
 * Analytics is deliberately best-effort and cannot fail a coding job.
 */
export class AnalyticsBridge {
  private readonly reporters: readonly ProjectReporter[];
  private readonly legacyReporter: AnalyticsReporter | undefined;
  private readonly subscriber: AnalyticsRecordSubscriber;
  private readonly logger: AnalyticsLogger;
  private readonly reporterByRunId = new Map<string, ProjectReporter>();
  private unsubscribe: (() => void) | undefined;
  private started = false;
  private stopped = false;

  public constructor(options: AnalyticsBridgeOptions) {
    this.logger = options.logger ?? noopLogger;
    this.subscriber = options.subscriber ?? defaultSubscriber;
    const overflow: OverflowCallback = (dropped, pending, suppressed) => {
      this.logger.warn("analytics queue overflow", {
        dropped,
        pending,
        suppressed,
      });
    };
    if (options.reporter !== undefined) {
      this.legacyReporter = options.reporter;
      this.reporters = [];
      return;
    }
    this.legacyReporter = undefined;
    const runsRoot = options.runsDir ?? join(options.dataDir, "conductor-runs");
    const factory =
      options.reporterFactory ??
      ((context: ProjectAnalyticsReporterOptions) =>
        defaultReporter(options, context, overflow));
    this.reporters = (options.projects ?? []).map((project) => {
      const runsDir = join(runsRoot, String(project.id));
      const cwd = join(
        options.dataDir,
        "repositories",
        String(project.id),
        repositoryName(project.repository, project.id),
      );
      return {
        projectId: project.id,
        runsDir,
        reporter: factory({ projectId: project.id, cwd, runsDir }, overflow),
      };
    });
  }

  /** Start backfill and subscribe to live records without blocking coding work. */
  public async start(): Promise<void> {
    if (this.started) return;
    if (this.stopped) throw new Error("analytics bridge cannot be restarted");
    this.started = true;
    for (const target of this.allReporters()) {
      try {
        await target.reporter.backfill();
      } catch (error) {
        this.logger.warn("analytics backfill failed", {
          error: safeErrorMessage(error),
          ...(target.projectId === undefined
            ? {}
            : { projectId: target.projectId }),
        });
      }
    }
    try {
      this.unsubscribe = this.subscriber.subscribe((record) => {
        const target = this.reporterFor(record);
        if (target === undefined) {
          this.logger.warn("analytics record has no project run directory", {
            runId: runIdOf(record),
          });
          return;
        }
        try {
          target.reporter.enqueue(record);
        } catch (error) {
          this.logger.warn("analytics enqueue failed", {
            error: safeErrorMessage(error),
            ...(target.projectId === undefined
              ? {}
              : { projectId: target.projectId }),
          });
        }
      });
    } catch (error) {
      this.logger.warn("analytics subscription failed", {
        error: safeErrorMessage(error),
      });
    }
  }

  /** Stop live delivery and flush the plugin's bounded shutdown queue. */
  public async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.unsubscribe?.();
    } catch (error) {
      this.logger.warn("analytics unsubscribe failed", {
        error: safeErrorMessage(error),
      });
    }
    this.unsubscribe = undefined;
    const totals = {
      enqueued: 0,
      delivered: 0,
      failed: 0,
      dropped: 0,
      pending: 0,
    };
    for (const target of this.allReporters()) {
      try {
        await target.reporter.shutdown();
      } catch (error) {
        this.logger.warn("analytics shutdown failed", {
          error: safeErrorMessage(error),
          ...(target.projectId === undefined
            ? {}
            : { projectId: target.projectId }),
        });
      }
      const stats = target.reporter.stats();
      totals.enqueued += stats.enqueued;
      totals.delivered += stats.delivered;
      totals.failed += stats.failed;
      totals.dropped += stats.dropped;
      totals.pending += stats.pending;
    }
    this.logger.info("analytics reporter stopped", {
      stats: totals,
    });
  }

  private allReporters(): ReadonlyArray<{
    readonly projectId?: ProjectId;
    readonly reporter: AnalyticsReporter;
  }> {
    return this.legacyReporter === undefined
      ? this.reporters
      : [{ reporter: this.legacyReporter }];
  }

  private reporterFor(
    record: PersistedRecord,
  ):
    | { readonly projectId?: ProjectId; readonly reporter: AnalyticsReporter }
    | undefined {
    if (this.legacyReporter !== undefined) {
      return { reporter: this.legacyReporter };
    }
    const runId = runIdOf(record);
    const cached = this.reporterByRunId.get(runId);
    if (cached !== undefined) return cached;
    const target = this.reporters.find((candidate) =>
      existsSync(join(candidate.runsDir, `${runId}.jsonl`)),
    );
    if (target !== undefined) this.reporterByRunId.set(runId, target);
    return target;
  }
}

const safeErrorMessage = (error: unknown): string => {
  // Error messages may contain endpoint credentials or response bodies.
  return error instanceof Error ? error.name : "UnknownError";
};

/** Create and start the daemon-wide analytics lifecycle bridge. */
export const startAnalyticsBridge = async (
  options: AnalyticsBridgeOptions,
): Promise<AnalyticsBridge> => {
  const bridge = new AnalyticsBridge(options);
  await bridge.start();
  return bridge;
};
