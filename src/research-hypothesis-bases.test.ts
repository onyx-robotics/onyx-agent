import { describe, expect, test } from "bun:test"

import { resolveHypothesisBaseOverrides } from "./commands/research"
import type { ApiCampaignExperiment, ApiHypothesis } from "./lib/api"

const hypotheses = [
  { id: "hypothesis-1", name: "one" },
  { id: "hypothesis-2", name: "two" },
  { id: "hypothesis-3", name: "three" },
] as ApiHypothesis[]

function experiment(id: string, resultCommitSha: string) {
  return { id, resultCommitSha } as ApiCampaignExperiment
}

describe("hypothesis base resolution", () => {
  test("resolves unique experiment ids through one pagination stream", async () => {
    const calls: Array<string | undefined> = []
    const overrides = await resolveHypothesisBaseOverrides({
      campaignId: "campaign",
      hypotheses,
      args: {
        positional: [],
        options: {},
        optionLists: {
          "hypothesis-base": [
            "one=experiment:experiment-old",
            "two=experiment:experiment-new",
            "three=experiment:experiment-old",
          ],
        },
      },
      listExperiments: async (_campaignId, _args, query) => {
        calls.push(query?.cursor)
        return query?.cursor
          ? {
              items: [experiment("experiment-old", "old-sha")],
              page: { nextCursor: null },
            }
          : {
              items: [experiment("experiment-new", "new-sha")],
              page: { nextCursor: "page-2" },
            }
      },
    })

    expect(calls).toEqual([undefined, "page-2"])
    expect(overrides.get("hypothesis-1")).toEqual({
      ref: "old-sha",
      sourceExperimentId: "experiment-old",
    })
    expect(overrides.get("hypothesis-2")).toEqual({
      ref: "new-sha",
      sourceExperimentId: "experiment-new",
    })
    expect(overrides.get("hypothesis-3")).toEqual({
      ref: "old-sha",
      sourceExperimentId: "experiment-old",
    })
  })

  test("does not fetch experiments for plain ref overrides", async () => {
    const overrides = await resolveHypothesisBaseOverrides({
      campaignId: "campaign",
      hypotheses,
      args: {
        positional: [],
        options: {},
        optionLists: { "hypothesis-base": ["one=refs/heads/main"] },
      },
      listExperiments: async () => {
        throw new Error("unexpected experiment list")
      },
    })

    expect(overrides.get("hypothesis-1")).toEqual({ ref: "refs/heads/main" })
  })

  test("reports a missing experiment after exhausting pagination", async () => {
    await expect(
      resolveHypothesisBaseOverrides({
        campaignId: "campaign",
        hypotheses,
        args: {
          positional: [],
          options: {},
          optionLists: {
            "hypothesis-base": ["one=experiment:missing-experiment"],
          },
        },
        listExperiments: async () => ({
          items: [],
          page: { nextCursor: null },
        }),
      })
    ).rejects.toThrow(
      "Experiment missing-experiment was not found in this campaign."
    )
  })
})
