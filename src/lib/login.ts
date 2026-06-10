import { createServer, type Server } from "node:http"

import { runProcess } from "./process"

export async function openBrowser(url: string) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    const result = await runProcess(command, args)
    if (result.code === 0) return
  } catch {
    // Fall through to printing the URL for headless or minimal systems.
  }
  console.log(`Open this URL to log in:\n${url}`)
}

export type CliLoginResult = {
  apiKey?: string
  apiKeyId?: string
  apiUrl?: string
  teamId: string
  teamName: string
  profileName?: string
  alreadyConfigured: boolean
}

const LOGIN_COMPLETE_MESSAGE =
  "Onyx CLI login complete. You can close this tab."

const ONYX_MARK_SVG = `<svg width="381" height="509" viewBox="0 0 381 509" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M381 382.14L233 508.018V424.447L298.75 368.525L190.501 151.379L82.25 368.526L149 425.297V508.867L0 382.14L190.501 0L381 382.14Z" fill="currentColor"/></svg>`
const CHECK_ICON_SVG = `<svg class="title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`

export function cliLoginCompleteHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Onyx CLI login complete</title>
  <style>
    :root {
      color-scheme: light;
      --background: oklch(1 0 0);
      --foreground: oklch(0.145 0 0);
      --card: oklch(1 0 0);
      --card-foreground: oklch(0.145 0 0);
      --muted-foreground: oklch(0.556 0 0);
      --border: oklch(0.922 0 0);
      --success: oklch(0.627 0.194 149.214);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: var(--background);
      color: var(--foreground);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    main {
      width: 100%;
      max-width: 672px;
    }

    .brand {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 32px;
      margin-bottom: 32px;
      font-size: 48px;
      line-height: 1.1;
      font-weight: 600;
      letter-spacing: 0;
    }

    .brand svg {
      width: 60px;
      height: 80px;
      flex: none;
    }

    .card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card);
      color: var(--card-foreground);
      box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
    }

    .card-header {
      padding: 24px;
    }

    .title-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .title-icon {
      width: 20px;
      height: 20px;
      flex: none;
      color: var(--success);
    }

    h1 {
      margin: 0;
      font-size: 16px;
      line-height: 24px;
      font-weight: 600;
      letter-spacing: 0;
    }

    p {
      margin: 8px 0 0;
      color: var(--muted-foreground);
      font-size: 14px;
      line-height: 20px;
    }
  </style>
</head>
<body>
  <main>
    <div class="brand">${ONYX_MARK_SVG}<span>Onyx</span></div>
    <section class="card" aria-labelledby="title">
      <div class="card-header">
        <div class="title-row">
          ${CHECK_ICON_SVG}
          <h1 id="title">${LOGIN_COMPLETE_MESSAGE}</h1>
        </div>
        <p>Your CLI profile is ready to use.</p>
      </div>
    </section>
  </main>
</body>
</html>`
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

export async function waitForCliLogin({
  port,
  state,
  timeoutMs,
}: {
  port: number
  state: string
  timeoutMs: number
}): Promise<CliLoginResult> {
  let server: Server | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null
  const login = new Promise<CliLoginResult>((resolveLogin, reject) => {
    server = createServer((request, response) => {
      response.setHeader("connection", "close")
      response.on("finish", () => request.socket.destroy())

      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`)
      if (url.pathname !== "/callback") {
        response.writeHead(404).end("Not found")
        return
      }

      if (url.searchParams.get("state") !== state) {
        response.writeHead(400).end("Invalid state")
        reject(new Error("Login callback returned an invalid state."))
        return
      }

      const teamId = url.searchParams.get("team_id")
      const teamName = url.searchParams.get("team_name")
      if (!teamId || !teamName) {
        response.writeHead(400).end("Missing team")
        reject(new Error("Login callback did not include a team."))
        return
      }

      const alreadyConfigured =
        url.searchParams.get("already_configured") === "true"
      const key = url.searchParams.get("api_key")
      if (!alreadyConfigured && !key) {
        response.writeHead(400).end("Missing API key")
        reject(new Error("Login callback did not include an API key."))
        return
      }

      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(cliLoginCompleteHtml())
      resolveLogin({
        apiKey: key ?? undefined,
        apiKeyId: url.searchParams.get("api_key_id") ?? undefined,
        apiUrl: url.searchParams.get("api_url") ?? undefined,
        teamId,
        teamName,
        profileName: url.searchParams.get("profile_name") ?? undefined,
        alreadyConfigured,
      })
    })
    server.listen(port, "127.0.0.1")
  })

  try {
    return await Promise.race([
      login,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for browser login.")),
          timeoutMs
        )
        timeout.unref()
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (server) await closeServer(server)
  }
}
