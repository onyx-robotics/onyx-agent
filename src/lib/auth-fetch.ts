export const AUTH_REQUEST_TIMEOUT_MS = 10_000

export class AuthRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Authentication request timed out after ${timeoutMs}ms`)
    this.name = "AuthRequestTimeoutError"
  }
}

/**
 * Bounds authentication I/O independently from the longer user-interaction
 * deadline. An existing caller signal is preserved and composed with the
 * per-request timeout.
 */
export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = AUTH_REQUEST_TIMEOUT_MS
): Promise<Response> {
  const boundedTimeoutMs = Math.max(1, Math.floor(timeoutMs))
  const timeoutSignal = AbortSignal.timeout(boundedTimeoutMs)
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal

  try {
    return await fetch(input, { ...init, signal })
  } catch (error) {
    if (timeoutSignal.aborted && !init.signal?.aborted) {
      throw new AuthRequestTimeoutError(boundedTimeoutMs)
    }
    throw error
  }
}
