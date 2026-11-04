/** The API's error envelope: `{ error: { code, message, issues?, retryable?, requestId } }`. */
export interface ApiErrorBody {
  error?: {
    code?: string
    message?: string
    issues?: { path: string; message: string }[]
    retryable?: boolean
    requestId?: string
  }
}

export class OnyxApiError extends Error {
  readonly status: number
  readonly code: string
  readonly issues?: { path: string; message: string }[]
  readonly retryable: boolean
  readonly requestId?: string

  constructor(status: number, body: ApiErrorBody) {
    const e = body.error ?? {}
    const detail = e.issues?.length
      ? `: ${e.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`
      : ""
    super(`${e.message ?? `HTTP ${status}`}${detail}`)
    this.name = "OnyxApiError"
    this.status = status
    this.code = e.code ?? "error"
    this.issues = e.issues
    this.retryable = e.retryable ?? (status === 429 || status >= 500)
    this.requestId = e.requestId
  }
}

/** The server couldn't be reached (down, unreachable, or too slow), after the client's retries. */
export class OnyxNetworkError extends Error {
  constructor(
    readonly url: string,
    cause: unknown
  ) {
    super(`couldn't reach ${new URL(url).origin}: ${(cause as Error)?.message ?? String(cause)}`, {
      cause,
    })
    this.name = "OnyxNetworkError"
  }
}
