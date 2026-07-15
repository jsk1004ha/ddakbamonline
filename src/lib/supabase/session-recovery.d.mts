type QueryResult = {
  error: unknown | null;
};

export function isTransientJwtTimingError(error: unknown): boolean;

export function retryTransientJwtRequest<Result extends QueryResult>(
  request: () => PromiseLike<Result> | Promise<Result>,
  pause?: (milliseconds: number) => Promise<void>,
): Promise<Result>;
