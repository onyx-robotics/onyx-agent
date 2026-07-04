import { describe, expect, test } from "bun:test"

import { activityLinesForOutput } from "./lib/process"

function lines(events: unknown[]) {
  return activityLinesForOutput(
    "stdout",
    events.map((event) => JSON.stringify(event)).join("\n")
  )
}

describe("activity lines", () => {
  test("tags claude assistant text and thinking as thoughts", () => {
    expect(
      lines([
        {
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "cache misses dominate" },
              { type: "text", text: "Trying a larger cache next." },
              { type: "tool_use", name: "Bash" },
            ],
          },
        },
      ])
    ).toEqual([
      "[stdout] thought: cache misses dominate",
      "[stdout] thought: Trying a larger cache next.",
      "[stdout] tool: Bash",
    ])
  })

  test("extracts codex agent messages, reasoning, and commands", () => {
    expect(
      lines([
        {
          type: "item.completed",
          item: { type: "reasoning", text: "The eval is IO-bound." },
        },
        {
          type: "item.completed",
          item: { type: "agent_message", text: "Switching to batched reads." },
        },
        {
          type: "item.completed",
          item: { type: "command_execution", command: "bash run.sh" },
        },
        { msg: { type: "agent_message", message: "Older stream shape." } },
      ])
    ).toEqual([
      "[stdout] thought: The eval is IO-bound.",
      "[stdout] thought: Switching to batched reads.",
      "[stdout] tool: bash run.sh",
      "[stdout] thought: Older stream shape.",
    ])
  })

  test("tags opencode text as thoughts and keeps step noise labeled", () => {
    expect(
      lines([
        { type: "text", text: "Sweeping KP from 20 to 60." },
        { type: "step_finish" },
      ])
    ).toEqual([
      "[stdout] thought: Sweeping KP from 20 to 60.",
      "[stdout] step: finish",
    ])
  })

  test("reads opencode part-nested text and drops whitespace-only parts", () => {
    // Real `opencode run --format json` shape: content nested in the part.
    expect(
      lines([
        {
          type: "text",
          timestamp: 1783204837022,
          part: {
            id: "prt_1",
            type: "text",
            text: "That scored 13.96 — something went wrong. Let me debug.",
          },
        },
        // Paragraph-separator parts must vanish instead of rendering as a
        // bare "text" event name.
        { type: "text", timestamp: 1783204837023, part: { type: "text", text: "\n\n" } },
        { type: "reasoning", part: { type: "reasoning", text: "IO-bound." } },
      ])
    ).toEqual([
      "[stdout] thought: That scored 13.96 — something went wrong. Let me debug.",
      "[stdout] thought: IO-bound.",
    ])
  })

  test("passes plain non-JSON output through untouched", () => {
    expect(activityLinesForOutput("stderr", "warning: slow eval\n")).toEqual([
      "[stderr] warning: slow eval",
    ])
  })
})
