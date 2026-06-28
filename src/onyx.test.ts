import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, test } from "bun:test"

import {
  commandResearchFinish,
  commandResearchShouldStop,
} from "./commands/research"
import { git } from "./lib/git"
import { researchRuntimeStatePath } from "./lib/research-runtime"
import { main } from "./main"

const SESSION_ID = "11111111-1111-4111-8111-111111111111"

let previousApiUrl: string | undefined
let previousApiKey: string | undefined
let previousFetch: typeof fetch | null = null

async function tempRepo(prefix = "onyx-remote-first-") {
  const root = await mkdtemp(join(tmpdir(), prefix))
  await git(["init"], root)
  await git(["config", "user.email", "test@example.com"], root)
  await git(["config", "user.name", "Onyx Test"], root)
  return root
}

function installMockApi(
  handler: (request: { method: string; path: string; body: unknown }) => unknown
) {
  previousApiUrl = process.env.ONYX_API_URL
  previousApiKey = process.env.ONYX_API_KEY
  previousFetch = globalThis.fetch
  process.env.ONYX_API_URL = "https://api.onyx.test"
  process.env.ONYX_API_KEY = "test-key"
  globalThis.fetch = (async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    )
    const bodyText =
      typeof init?.body === "string" && init.body.length > 0 ? init.body : null
    const response = handler({
      method: init?.method ?? "GET",
      path: url.pathname,
      body: bodyText ? JSON.parse(bodyText) : null,
    })
    return new Response(JSON.stringify({ data: response }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

afterEach(() => {
  if (previousFetch) globalThis.fetch = previousFetch
  previousFetch = null
  if (previousApiUrl === undefined) delete process.env.ONYX_API_URL
  else process.env.ONYX_API_URL = previousApiUrl
  if (previousApiKey === undefined) delete process.env.ONYX_API_KEY
  else process.env.ONYX_API_KEY = previousApiKey
})

describe("remote-first agent architecture", () => {
  test("runtime state no longer points at .git/onyx/research.db", async () => {
    const root = await tempRepo()
    try {
      const path = await researchRuntimeStatePath(root)
      expect(path).toEndWith(".git/onyx/runtime/runtime-state.json")
      expect(path).not.toContain("research.db")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("public sync and push commands are removed", async () => {
    const originalError = console.error
    const originalExit = process.exit
    const errors: string[] = []
    console.error = (message?: unknown) => {
      errors.push(String(message))
    }
    process.exit = ((code?: number) => {
      throw new Error(`exit ${code ?? 0}`)
    }) as typeof process.exit
    try {
      await expect(main(["push"])).rejects.toThrow("exit 1")
      await expect(main(["sync"])).rejects.toThrow("exit 1")
      expect(errors.join("\n")).toContain("removed")
    } finally {
      console.error = originalError
      process.exit = originalExit
    }
  })

  test("should-stop polls the remote control-state endpoint", async () => {
    const root = await tempRepo()
    const logs: string[] = []
    const originalLog = console.log
    console.log = (message?: unknown) => {
      logs.push(String(message))
    }
    installMockApi(({ method, path }) => {
      expect(method).toBe("GET")
      expect(path).toBe(`/api/v1/research/sessions/${SESSION_ID}/control-state`)
      return {
        sessionId: SESSION_ID,
        status: "running",
        finalizationStatus: "running",
        progress: {
          experimentTarget: 3,
          acceptedExperimentCount: 1,
          remainingExperimentCount: 2,
          deadlineAt: null,
          terminalReason: null,
        },
        finalization: {
          status: "running",
          reasons: [],
          terminalReason: null,
          unmeasuredSalvageCount: 0,
        },
        updatedAt: new Date().toISOString(),
      }
    })
    try {
      await commandResearchShouldStop({
        positional: ["research", "should-stop"],
        options: { cwd: root, session: SESSION_ID, json: "true" },
      })
      const payload = JSON.parse(logs.join("\n"))
      expect(payload.shouldStop).toBe(false)
      expect(payload.sessionId).toBe(SESSION_ID)
    } finally {
      console.log = originalLog
      await rm(root, { recursive: true, force: true })
    }
  })

  test("finish rejects removed offline and sync flags", async () => {
    const root = await tempRepo()
    try {
      await expect(
        commandResearchFinish({
          positional: ["research", "finish"],
          options: { cwd: root, offline: "true", campaign: "smoke" },
        })
      ).rejects.toThrow("removed")
      await expect(
        commandResearchFinish({
          positional: ["research", "finish"],
          options: { cwd: root, "final-sync-timeout": "1", campaign: "smoke" },
        })
      ).rejects.toThrow("removed")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
