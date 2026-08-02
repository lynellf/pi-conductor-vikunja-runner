export type LogLevel = "info" | "warn" | "error";

export interface JsonLogger {
  info(event: string, details?: Readonly<Record<string, unknown>>): void;
  warn(event: string, details?: Readonly<Record<string, unknown>>): void;
  error(
    event: string,
    error?: unknown,
    details?: Readonly<Record<string, unknown>>,
  ): void;
}

const MAX_LOG_TEXT = 2000;

/** Redact common credential shapes before serializing external error text. */
export const redactLogText = (value: string): string =>
  value
    .replace(/(Authorization\s*:\s*)(?:Bearer\s+)?[^\s]+/gi, "$1[REDACTED]")
    .replace(
      /\b(token|password|secret|api[_-]?key)=([^\s]+)/gi,
      "$1=[REDACTED]",
    )
    .slice(0, MAX_LOG_TEXT);

const safeValue = (value: unknown): unknown => {
  if (typeof value === "string") return redactLogText(value);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(safeValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /token|password|secret|authorization|api[_-]?key/i.test(key)
          ? "[REDACTED]"
          : safeValue(entry),
      ]),
    );
  }
  return String(value);
};

export const createJsonLogger = (
  write: (line: string) => void = (line) => console.log(line),
): JsonLogger => {
  const emit = (
    level: LogLevel,
    event: string,
    details: Readonly<Record<string, unknown>> = {},
  ): void => {
    write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...(safeValue(details) as Record<string, unknown>),
      }),
    );
  };
  return {
    info: (event, details) => emit("info", event, details),
    warn: (event, details) => emit("warn", event, details),
    error: (event, error, details = {}) =>
      emit("error", event, {
        ...details,
        ...(error === undefined
          ? {}
          : {
              error:
                error instanceof Error
                  ? { name: error.name, message: redactLogText(error.message) }
                  : { name: "UnknownError" },
            }),
      }),
  };
};

export const runnerLogger = createJsonLogger();
