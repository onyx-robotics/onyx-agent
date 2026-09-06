import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git } from "./git"
import {
  preserveResultRef,
  withDeliveryOwner,
  withAttemptDeliveryOwner,
  recoverReports,
  pendingReportSummary,
  saveCleanupReceipt,
} from "./report-delivery"
import { apiData, adaptResearchApiPayload } from "./api"

test("immutable local ref survives branch removal and rejects conflicting commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "onyx-ref-test-"))
  try {
    await git(["init", "--quiet"], root)
    await git(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "result",
      ],
      root
    )
    const commit = await git(["rev-parse", "HEAD"], root)
    const ref = "refs/onyx/experiments/campaign/attempt"
    await preserveResultRef(root, commit, ref)
    await preserveResultRef(root, commit, ref)
    await writeFile(join(root, "next"), "new")
    await git(["add", "next"], root)
    await git(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "next",
      ],
      root
    )
    await expect(
      preserveResultRef(root, await git(["rev-parse", "HEAD"], root), ref)
    ).rejects.toThrow("conflicts")
    expect(await git(["rev-parse", ref], root)).toBe(commit)
    await withDeliveryOwner(root, async () => {
      await expect(withDeliveryOwner(root, async () => 1)).rejects.toThrow(
        "occupied"
      )
    })
    expect(await withDeliveryOwner(root, async () => 2)).toBe(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test("DTO adaptation leaves arbitrary nested metadata and plans untouched", () => {
  const metadata = {
    runtimeState: "ended",
    metricName: "x",
    currentEvaluationRevision: {},
    nested: { runtimeState: "active" },
  }
  const payload = {
    data: {
      session: { runtimeState: "ended", endReason: "user_stopped", metadata },
      campaign: {
        metricName: "score",
        currentEvaluationRevision: null,
        metadata,
      },
    },
  }
  const result = apiData<{
    session: { status: string; metadata: unknown }
    campaign: { metadata: unknown }
  }>(
    adaptResearchApiPayload(payload, "/api/v1/research/sessions/session/state")
  )
  expect(result.session.status).toBe("stopped")
  expect(result.session.metadata).toEqual(metadata)
  expect(result.campaign.metadata).toEqual(metadata)
  expect(apiData<typeof metadata>({ data: metadata })).toEqual(metadata)
  expect(payload.data.session).not.toHaveProperty("status")
})

test("different attempts report concurrently while recovery skips an occupied attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "onyx-report-concurrency-"))
  try {
    await git(["init", "--quiet"], root)
    let unlock!: () => void
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      unlock = resolve
    })
    const first = withAttemptDeliveryOwner(root, "first", async () => {
      entered()
      await gate
    })
    await ready
    try {
      expect(
        await withAttemptDeliveryOwner(root, "second", async () => "reported")
      ).toBe("reported")
      await expect(
        withAttemptDeliveryOwner(root, "first", async () => {}, 0)
      ).rejects.toThrow("Timed out")
      // Drainer exclusion does not block either foreground attempt.
      await withDeliveryOwner(root, async () => {
        expect(
          await withAttemptDeliveryOwner(root, "third", async () => "reported")
        ).toBe("reported")
        expect(
          (await recoverReports(root, { positional: [], options: {} })).pending
        ).toBe(0)
      })
    } finally {
      unlock()
      await first
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("recovery pushes unsealed measurements and retains acknowledged reports until failed pushes recover", async () => {
  const { writeLocalAttempt, listLocalAttempts } =
    await import("./research-runtime")
  const root = await mkdtemp(join(tmpdir(), "onyx-recovery-push-"))
  const previousKey = process.env.ONYX_API_KEY
  const previousUrl = process.env.ONYX_API_URL
  const bodies: Array<Record<string, unknown>> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "GET") {
        const path = new URL(request.url).pathname
        if (!path.endsWith("/overview") && !path.includes("/projects/"))
          return new Response("Unsupported GET", { status: 405 })
        return Response.json({
          data: new URL(request.url).pathname.includes("/projects/")
            ? { teamId: "team" }
            : { campaign: { projectId: "project" } },
        })
      }
      const body = (await request.json()) as Record<string, unknown>
      bodies.push(body)
      return Response.json({
        data: { outcome: "recorded", experiment: { runRef: body.runRef } },
      })
    },
  })
  process.env.ONYX_API_KEY = "fixture-key"
  process.env.ONYX_API_URL = server.url.origin
  try {
    await git(["init", "--quiet"], root)
    await git(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "measurement",
      ],
      root
    )
    const commit = await git(["rev-parse", "HEAD"], root)
    const remote = join(root, "remote.git")
    await git(["init", "--bare", remote], root)
    await git(["remote", "add", "origin", remote], root)
    const attempt = (runRef: string) =>
      ({
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        runRef,
        resultCommitSha: commit,
        resultRef: `refs/onyx/experiments/campaign/${runRef}`,
        sessionId: "session",
        delivery: {
          version: 1,
          destination: {
            apiUrl: server.url.origin,
            teamId: "team",
            campaignId: "campaign",
          },
          body: {
            runRef,
            resultCommitSha: commit,
            resultRef: `refs/onyx/experiments/campaign/${runRef}`,
            name: "Saved measurement",
            resultRefPushStatus: "failed",
            resultRefPushError: "Not pushed yet",
          },
          sealed: false,
          attempts: 0,
          nextAttemptAt: 0,
          state: "pending",
        },
      }) as unknown as Parameters<typeof writeLocalAttempt>[0]["record"]
    const args = { positional: [], options: {} }
    const first = attempt("unsealed")
    await writeLocalAttempt({ root, record: first })
    await withAttemptDeliveryOwner(root, first.runRef, async () => {
      await recoverReports(root, args)
      expect(bodies).toHaveLength(0)
      expect((await listLocalAttempts(root))[0]?.delivery?.sealed).toBe(false)
    })
    await recoverReports(root, args)
    expect(bodies[0]?.resultRefPushStatus).toBe("pushed")
    expect(bodies[0]).not.toHaveProperty("resultRefPushError")
    expect(
      await git(["--git-dir", remote, "rev-parse", first.resultRef], root)
    ).toBe(commit)
    expect(await listLocalAttempts(root)).toHaveLength(0)

    await git(
      ["remote", "set-url", "origin", join(root, "unavailable.git")],
      root
    )
    await writeLocalAttempt({ root, record: attempt("outage") })
    await recoverReports(root, args)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]?.resultRefPushStatus).toBe("failed")
    const pending = (await listLocalAttempts(root))[0]!
    expect(pending.delivery?.reportAcknowledged).toBe(true)
    expect<unknown>(pending.delivery?.body).toEqual(bodies[1])
    expect((await pendingReportSummary(root)).blocked).toBe(1)
    // Only the saved commit/ref is needed: no experiment worktree or branch.
    await git(["remote", "set-url", "origin", remote], root)
    pending.delivery!.nextAttemptAt = 0
    await writeLocalAttempt({ root, record: pending })
    await recoverReports(root, args)
    expect(bodies).toHaveLength(2)
    expect(
      await git(["--git-dir", remote, "rev-parse", pending.resultRef], root)
    ).toBe(commit)
    expect(await listLocalAttempts(root)).toHaveLength(0)
  } finally {
    server.stop(true)
    if (previousKey === undefined) delete process.env.ONYX_API_KEY
    else process.env.ONYX_API_KEY = previousKey
    if (previousUrl === undefined) delete process.env.ONYX_API_URL
    else process.env.ONYX_API_URL = previousUrl
    await rm(root, { recursive: true, force: true })
  }
})

test("recovery replays the frozen report after a lost acknowledgement and preserves definitive failures", async () => {
  const { writeLocalAttempt, listLocalAttempts, clearLocalAttempt } =
    await import("./research-runtime")
  const root = await mkdtemp(join(tmpdir(), "onyx-delivery-test-"))
  const previousKey = process.env.ONYX_API_KEY
  const previousUrl = process.env.ONYX_API_URL
  let mode = "lost-response"
  let cleanupRevision = 17
  let cleanupPatches = 0
  const reports: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path.endsWith("/live"))
        return Response.json({
          data: {
            sites: [
              {
                siteId: "site",
                supervisorRunId: "supervisor",
                cleanupRevision,
                runtimeStatus: "failed",
              },
            ],
          },
        })
      if (request.method === "PATCH") {
        const input = (await request.json()) as { expectedRevision: number }
        expect(input.expectedRevision).toBe(cleanupRevision)
        cleanupPatches++
        return cleanupPatches === 1
          ? Response.json(
              {
                error: {
                  code: "unavailable",
                  message: "Cleanup acknowledgement lost",
                },
              },
              { status: 503 }
            )
          : Response.json({ data: {} })
      }
      if (request.method === "GET") {
        const path = new URL(request.url).pathname
        if (!path.endsWith("/overview") && !path.includes("/projects/"))
          return new Response("Unsupported GET", { status: 405 })
        return Response.json({
          data: path.includes("/projects/")
            ? { teamId: mode === "wrong-team" ? "foreign" : "team" }
            : { campaign: { projectId: "project" } },
        })
      }
      const body = (await request.json()) as { runRef: string }
      reports.push(body)
      if (mode === "conflict")
        return Response.json(
          { error: { code: "conflict", message: "Different report" } },
          { status: 409 }
        )
      if (reports.length === 1)
        return Response.json(
          {
            error: {
              code: "unavailable",
              message: "Response lost after commit",
            },
          },
          { status: 503 }
        )
      return Response.json({
        data: { outcome: "duplicate", experiment: { runRef: body.runRef } },
      })
    },
  })
  process.env.ONYX_API_KEY = "fixture-key"
  process.env.ONYX_API_URL = server.url.origin
  try {
    await git(["init", "--quiet"], root)
    await git(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "measurement",
      ],
      root
    )
    const remote = join(root, "remote.git")
    await git(["init", "--bare", remote], root)
    await git(["remote", "add", "origin", remote], root)
    const commit = await git(["rev-parse", "HEAD"], root)
    const body = {
      runRef: "attempt",
      name: "Original description",
      agentNotes: { metricName: "opaque", runtimeState: "mine" },
      resultCommitSha: commit,
      resultRefPushStatus: "failed",
    }
    const record = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      runRef: "attempt",
      resultCommitSha: commit,
      resultRef: "refs/onyx/experiments/campaign/attempt",
      sessionId: "session",
      delivery: {
        version: 1,
        destination: {
          apiUrl: server.url.origin,
          teamId: "team",
          campaignId: "campaign",
        },
        body,
        sealed: true,
        attempts: 0,
        nextAttemptAt: 0,
        state: "pending",
      },
    } as unknown as Parameters<typeof writeLocalAttempt>[0]["record"]
    await writeLocalAttempt({ root, record })
    const args = { positional: [], options: {} }
    await recoverReports(root, args)
    expect(reports).toHaveLength(2)
    expect(reports[0]).toEqual(reports[1])
    expect(await listLocalAttempts(root)).toHaveLength(0)
    expect(await git(["rev-parse", record.resultRef], root)).toBe(commit)

    mode = "wrong-team"
    await writeLocalAttempt({ root, record })
    await recoverReports(root, args)
    expect(reports).toHaveLength(2)
    expect((await listLocalAttempts(root))[0]?.delivery?.state).toBe("blocked")

    mode = "conflict"
    await writeLocalAttempt({ root, record })
    await recoverReports(root, args)
    expect((await listLocalAttempts(root))[0]?.delivery?.state).toBe("rejected")
    await recoverReports(root, args)
    expect(reports).toHaveLength(3)

    await mkdir(join(root, ".git/onyx/attempts"), { recursive: true })
    await writeFile(join(root, ".git/onyx/attempts/broken.json"), "{partial")
    expect((await pendingReportSummary(root)).blocked).toBe(1)
    expect((await pendingReportSummary(root)).pending).toBe(2)
    await clearLocalAttempt(root, { runRef: record.runRef })
    await rm(join(root, ".git/onyx/attempts/broken.json"))
    mode = "cleanup"
    await saveCleanupReceipt(root, {
      destination: record.delivery!.destination,
      sessionId: "session",
      siteId: "site",
      supervisorRunId: "supervisor",
      readyExceptDelivery: true,
    })
    await recoverReports(root, args)
    expect(cleanupPatches).toBe(1)
    expect(
      await readdir(join(root, ".git/onyx/delivery-cleanup"))
    ).toHaveLength(1)
    cleanupRevision++
    await recoverReports(root, args)
    expect(cleanupPatches).toBe(2)
    expect(
      await readdir(join(root, ".git/onyx/delivery-cleanup"))
    ).toHaveLength(0)
  } finally {
    server.stop(true)
    if (previousKey === undefined) delete process.env.ONYX_API_KEY
    else process.env.ONYX_API_KEY = previousKey
    if (previousUrl === undefined) delete process.env.ONYX_API_URL
    else process.env.ONYX_API_URL = previousUrl
    await rm(root, { recursive: true, force: true })
  }
})
