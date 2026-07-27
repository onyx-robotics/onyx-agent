import { describe, expect, test } from "bun:test"

import { createLifecycleHeartbeatPublisher } from "./commands/research"

function heartbeat(workerId: string) {
  return {
    workerId,
    leaseToken: `lease-${workerId}`,
    status: "stopped" as const,
    sessionId: "30000000-0000-4000-8000-000000000001",
    hypothesisId: "40000000-0000-4000-8000-000000000001",
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
        { positional: [], options: {} },
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
      { positional: [], options: {} },
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
