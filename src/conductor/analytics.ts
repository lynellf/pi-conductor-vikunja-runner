import { join } from "node:path";
import { type PersistedRecord, subscribeToRecords } from "pi-conductor";
import {
  type AnalyticsReporter,
  type AnalyticsReporterOptions,
  createAnalyticsReporter,
  type OverflowCallback,
} from "pi-conductor-analytics-plugin";

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
  readonly reporter?: AnalyticsReporter;
  readonly subscriber?: AnalyticsRecordSubscriber;
  readonly logger?: AnalyticsLogger;
}

const noopLogger: AnalyticsLogger = {
  warn: () => undefined,
  info: () => undefined,
};

const defaultSubscriber: AnalyticsRecordSubscriber = {
  subscribe: (listener) => subscribeToRecords(listener),
};

const defaultReporter = (
  options: AnalyticsBridgeOptions,
  overflow: OverflowCallback,
): AnalyticsReporter => {
  const reporterOptions: AnalyticsReporterOptions = {
    cwd: options.dataDir,
    runsDir: options.runsDir ?? join(options.dataDir, "conductor-runs"),
    configPath: options.configPath,
    source: options.source ?? ANALYTICS_SOURCE,
  };
  return createAnalyticsReporter(reporterOptions, overflow);
};

/**
 * Own the daemon-wide analytics reporter and record subscription. Spec §13.
 * Analytics is deliberately best-effort and cannot fail a coding job.
 */
export class AnalyticsBridge {
  private readonly reporter: AnalyticsReporter;
  private readonly subscriber: AnalyticsRecordSubscriber;
  private readonly logger: AnalyticsLogger;
  private unsubscribe: (() => void) | undefined;
  private started = false;
  private stopped = false;

  public constructor(options: AnalyticsBridgeOptions) {
    this.logger = options.logger ?? noopLogger;
    this.subscriber = options.subscriber ?? defaultSubscriber;
    this.reporter =
      options.reporter ??
      defaultReporter(options, (dropped, pending, suppressed) => {
        this.logger.warn("analytics queue overflow", {
          dropped,
          pending,
          suppressed,
        });
      });
  }

  /** Start backfill and subscribe to live records without blocking coding work. */
  public async start(): Promise<void> {
    if (this.started) return;
    if (this.stopped) throw new Error("analytics bridge cannot be restarted");
    this.started = true;
    try {
      await this.reporter.backfill();
    } catch (error) {
      this.logger.warn("analytics backfill failed", {
        error: safeErrorMessage(error),
      });
    }
    try {
      this.unsubscribe = this.subscriber.subscribe((record) => {
        try {
          this.reporter.enqueue(record);
        } catch (error) {
          this.logger.warn("analytics enqueue failed", {
            error: safeErrorMessage(error),
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
    try {
      await this.reporter.shutdown();
    } catch (error) {
      this.logger.warn("analytics shutdown failed", {
        error: safeErrorMessage(error),
      });
    }
    this.logger.info("analytics reporter stopped", {
      stats: this.reporter.stats(),
    });
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
