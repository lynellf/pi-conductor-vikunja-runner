export class VikunjaHttpError extends Error {
  public readonly status: number | null;
  public readonly retryable: boolean;

  public constructor(
    message: string,
    status: number | null,
    retryable: boolean,
  ) {
    super(message);
    this.name = "VikunjaHttpError";
    this.status = status;
    this.retryable = retryable;
  }
}

export class VikunjaResponseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "VikunjaResponseError";
  }
}

/**
 * External retry policy is defined once at the Vikunja boundary. Callers must
 * not turn authorization, validation, or semantic response failures into
 * unbounded retries after the HTTP adapter has classified them.
 */
export const isRetryableVikunjaError = (error: unknown): boolean =>
  error instanceof VikunjaHttpError && error.retryable;
