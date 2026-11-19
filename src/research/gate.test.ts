import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { NO_TOOLS, readOnlyTools, workerTools } from "./agents"
import { gateFiles, judge, runGate, simpleCommands } from "./gate"

const sh = (command: string) => ({ command })
const ok = { allow: true } as const

test("a command is split where the shell would, quotes kept whole", () => {
  expect(simpleCommands(`cd w && onyx research note "a && b; c" | tail -3; echo $?`)).toEqual([
    "cd w",
    `onyx research note "a && b; c"`,
    "tail -3",
    "echo $?",
  ])
  expect(simpleCommands("onyx research run x 2>&1 | tail")).toEqual(["onyx research run x", "tail"])
  expect(simpleCommands("git status > /dev/null")).toEqual(["git status"])
})

test("what no rule can vouch for isn't split, it's refused", () => {
  for (const c of [
    "echo $(python x.py)",
    'echo "`python x.py`"',
    "cat x > y.py",
    "echo hi >> notes",
    "cat < x",
    "(python x.py)",
    "{ python x.py; }",
    `echo "unclosed`,
  ])
    expect([c, simpleCommands(c)]).toEqual([c, null])
  // in single quotes it's text
  expect(simpleCommands(`onyx research note '$(not run) > nowhere'`)).toEqual([
    `onyx research note '$(not run) > nowhere'`,
  ])
})

test("a worker runs onyx research and read-only git, edits files, and nothing else", () => {
  const w = workerTools()
  expect(judge(w, "Bash", sh("cd /w && onyx research run bench x | tail -30"))).toEqual(ok)
  expect(judge(w, "Bash", sh("git diff HEAD~1"))).toEqual(ok)
  expect(judge(w, "apply_patch", { command: "*** Begin Patch\n..." })).toEqual(ok)
  for (const c of ["python bench.py", "cd /w && python bench.py", "git commit -m x", "bash -c 'x'"])
    expect(judge(w, "Bash", sh(c)).allow).toBe(false)
  expect(judge(w, "Bash", sh("python bench.py"))).toEqual({
    allow: false,
    reason: "`python bench.py` isn't a command this agent may run",
  })
})

test("a shell argv is checked as the script it runs", () => {
  const w = workerTools()
  expect(judge(w, "Bash", { command: ["bash", "-lc", "onyx research help"] })).toEqual(ok)
  expect(judge(w, "Bash", { command: ["/bin/zsh", "-c", "python x.py"] }).allow).toBe(false)
  expect(judge(w, "Bash", { command: ["python", "x.py"] }).allow).toBe(false)
})

test("a read-only agent runs only its commands and edits nothing; a ghost does nothing", () => {
  const r = readOnlyTools(["onyx research aspect *"])
  expect(judge(r, "Bash", sh(`onyx research aspect "speed" "the loop"`))).toEqual(ok)
  expect(judge(r, "Bash", sh("onyx research propose x")).allow).toBe(false)
  expect(judge(r, "apply_patch", { command: "*** Begin Patch" }).allow).toBe(false)
  expect(judge(r, "Edit", { file_path: "x" }).allow).toBe(false)
  expect(judge(NO_TOOLS, "Bash", sh("ls")).allow).toBe(false)
  // a tool that's neither a shell nor an edit (an MCP server's, say) isn't any agent's
  expect(judge(workerTools(), "mcp__x__y", { q: 1 }).allow).toBe(false)
})

test("the hook refuses with exit 2, says why, and keeps what it refused and let through", () => {
  const dir = mkdtempSync(join(tmpdir(), "onyx-gate-"))
  const rules = join(dir, "rules.json")
  writeFileSync(rules, JSON.stringify(workerTools()))
  const call = (command: string) =>
    runGate(rules, JSON.stringify({ tool_name: "Bash", tool_input: { command } }))
  expect(call("onyx research help")).toEqual({ exit: 0, stderr: "" })
  const no = call("python x.py")
  expect(no.exit).toBe(2)
  expect(no.stderr).toContain("refused by the run")
  const f = gateFiles(rules)
  expect(readFileSync(f.denied, "utf8")).toBe('{"tool":"Bash","command":"python x.py"}\n')
  expect(readFileSync(f.allowed, "utf8")).toBe("1\n")
  // no rules, or a call it can't read: nothing gets through
  expect(runGate(join(dir, "none.json"), "{}").exit).toBe(2)
  expect(runGate(rules, "not json").exit).toBe(2)
})
