const JWT_CLOCK_SKEW_PATTERN =
  /(?:jwt\s+)?issued\s+(?:(?:in\s+the|at)\s+)?future|not\s+(?:active|valid)\s+yet|not\s+before|\bnbf\b/i;

function wait(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

export function isTransientJwtTimingError(error) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  const message = "message" in error ? error.message : undefined;
  return (
    code === "PGRST301" &&
    typeof message === "string" &&
    JWT_CLOCK_SKEW_PATTERN.test(message)
  );
}

export async function retryTransientJwtRequest(request, pause = wait) {
  const first = await request();
  if (!isTransientJwtTimingError(first.error)) return first;

  await pause(250);
  return request();
}
