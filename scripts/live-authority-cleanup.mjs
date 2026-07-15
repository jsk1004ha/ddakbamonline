export async function runCleanupSteps(steps) {
  const errors = [];

  for (const step of steps) {
    try {
      await step.run();
    } catch (cause) {
      errors.push(new Error(`${step.label} cleanup failed`, { cause }));
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "Disposable live QA cleanup failed");
  }
}

export function throwQaOrCleanupError(qaError, cleanupError) {
  const hasQaError = qaError !== null && qaError !== undefined;
  const hasCleanupError = cleanupError !== null && cleanupError !== undefined;

  if (hasQaError && hasCleanupError) {
    const cleanupErrors =
      cleanupError instanceof AggregateError
        ? cleanupError.errors
        : [cleanupError];

    throw new AggregateError(
      [qaError, ...cleanupErrors],
      "Live authority QA failed and disposable cleanup was incomplete",
      { cause: qaError },
    );
  }

  if (hasQaError) {
    throw qaError;
  }

  if (hasCleanupError) {
    throw cleanupError;
  }
}
