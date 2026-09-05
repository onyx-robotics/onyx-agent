import { createServer, type Server } from "node:http"

import { runProcess } from "./process"

export const BROWSER_OPEN_TIMEOUT_MS = 5_000

export async function openBrowser(
  url: string,
  options: {
    platform?: NodeJS.Platform
    timeoutMs?: number
    run?: typeof runProcess
  } = {}
) {
  const targetPlatform = options.platform ?? process.platform
  const command =
    targetPlatform === "darwin"
      ? "open"
      : targetPlatform === "win32"
        ? "cmd"
        : "xdg-open"
  const args =
    targetPlatform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    const result = await (options.run ?? runProcess)(command, args, {
      timeoutMs: options.timeoutMs ?? BROWSER_OPEN_TIMEOUT_MS,
    })
    return result.code === 0 && !result.timedOut
  } catch {
    return false
  }
}

const LOGIN_COMPLETE_MESSAGE =
  "Onyx CLI login complete. You can close this tab."

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function loginResultHtml({
  title,
  message,
}: {
  title: string
  message: string
}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; font-family: ui-sans-serif, system-ui, sans-serif; }
    main { width: min(100%, 560px); border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 10px; padding: 28px; }
    h1 { margin: 0; font-size: 18px; }
    p { margin: 10px 0 0; opacity: .7; }
  </style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body>
</html>`
}

export function cliLoginCompleteHtml() {
  return loginResultHtml({
    title: "Onyx CLI login complete",
    message: LOGIN_COMPLETE_MESSAGE,
  })
}

function closeServer(server: Server) {
  return new Promise<void>((resolveClose) => {
    const forceClose = setTimeout(() => {
      server.closeAllConnections()
      resolveClose()
    }, 1_000)
    forceClose.unref()
    server.close(() => {
      clearTimeout(forceClose)
      resolveClose()
    })
    server.closeIdleConnections()
  })
}

export type LoopbackCallback = {
  redirectUri: string
  waitForCode: () => Promise<string>
  close: () => Promise<void>
}

export async function createLoopbackCallback({
  state,
  timeoutMs,
  lingerMs = 1_500,
}: {
  state: string
  timeoutMs: number
  lingerMs?: number
}): Promise<LoopbackCallback> {
  let completed = false
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  const result = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  const server = createServer((request, response) => {
    response.setHeader("connection", "close")
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`)
    if (url.pathname !== "/callback") {
      response.writeHead(404).end("Not found")
      return
    }
    if (url.searchParams.get("state") !== state) {
      response.writeHead(400).end("Invalid state")
      return
    }
    if (completed) {
      response
        .writeHead(409, { "content-type": "text/html; charset=utf-8" })
        .end(
          loginResultHtml({
            title: "Onyx CLI callback already used",
            message: "This one-time login callback has already been consumed.",
          })
        )
      return
    }

    const error = url.searchParams.get("error")
    if (error) {
      completed = true
      const description =
        url.searchParams.get("error_description") ?? "Login was not completed"
      response
        .writeHead(400, { "content-type": "text/html; charset=utf-8" })
        .end(
          loginResultHtml({
            title: "Onyx CLI login failed",
            message: description,
          })
        )
      rejectCode(new Error(`${description} (${error})`))
      return
    }

    const code = url.searchParams.get("code")
    if (!code) {
      response.writeHead(400).end("Missing authorization code")
      return
    }
    completed = true
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(cliLoginCompleteHtml())
    resolveCode(code)
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    await closeServer(server)
    throw new Error("Unable to determine the CLI login callback port")
  }
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await closeServer(server)
  }

  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    close,
    async waitForCode() {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const code = await Promise.race([
          result,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Timed out waiting for browser login.")),
              timeoutMs
            )
            timeout.unref()
          }),
        ])
        if (lingerMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, lingerMs))
        }
        return code
      } finally {
        if (timeout) clearTimeout(timeout)
        await close()
      }
    },
  }
}
