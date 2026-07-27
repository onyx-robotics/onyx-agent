import { describe, expect, test } from "bun:test"

import { createLifecycleHeartbeatPublisher } from "./commands/research"

function heartbeat(workerId: string) {
  return {
    workerId,
    status: "stopped" as const,
    phase: "stopped",
    event: "stop_requested",
  }
}

describe("supervisor lifecycle heartbeat publisher", () => {
  test.each([10, 100])(
    "coalesces %i simultaneous terminal workers",
    async (count) => {
      const batches: string[][] = []
      const publisher = createLifecycleHeartbeatPublisher(
        {
          args: { positional: [], options: {} },
          sessionId: "30000000-0000-4000-8000-000000000001",
          siteId: "50000000-0000-4000-8000-000000000001",
          supervisorRunId: "test-run",
        },
        async ({ heartbeats }) => {
          batches.push(heartbeats.map((item) => item.workerId))
          return {
            results: heartbeats.map((item) => ({
              workerId: item.workerId,
              ok: true as const,
              worker: {} as never,
              heartbeat: {} as never,
            })),
          }
        }
      )

      await Promise.all(
        Array.from({ length: count }, (_, index) =>
          publisher.enqueue(heartbeat(`worker-${index}`))
        )
      )

      expect(batches).toHaveLength(1)
      expect(batches[0]).toHaveLength(count)
    }
  )

  test("attributes partial batch failures to the affected worker", async () => {
    const publisher = createLifecycleHeartbeatPublisher(
      {
        args: { positional: [], options: {} },
        sessionId: "30000000-0000-4000-8000-000000000001",
        siteId: "50000000-0000-4000-8000-000000000001",
        supervisorRunId: "test-run",
      },
      async ({ heartbeats }) => ({
        results: heartbeats.map((item, index) =>
          index === 0
            ? {
                workerId: item.workerId,
                ok: false as const,
                error: { code: "lease_expired", message: "Lease expired" },
              }
            : {
                workerId: item.workerId,
                ok: true as const,
                worker: {} as never,
                heartbeat: {} as never,
              }
        ),
      })
    )

    const outcomes = await Promise.allSettled([
      publisher.enqueue(heartbeat("worker-failed")),
      publisher.enqueue(heartbeat("worker-ok")),
    ])

    expect(outcomes[0]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringContaining("worker-failed: Lease expired"),
      }),
    })
    expect(outcomes[1]).toEqual({ status: "fulfilled", value: undefined })
  })
})
