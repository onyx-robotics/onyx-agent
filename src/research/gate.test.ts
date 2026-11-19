import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { NO_TOOLS, readOnlyTools, workerTools } from "./agents"
import { gateFiles, judge, onlyReads, patchPaths, runGate, simpleCommands } from "./gate"

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

test("an agent that may read files may read them with its shell, as Codex does", () => {
  const r = readOnlyTools(["onyx research aspect *"])
  for (const c of [
    "cat model.py",
    "sed -n '1,200p' onyx/endpoints/cyclelife.md",
    "sed -n '1,80p;120,160p' model.py | nl -ba",
    "rg -n 'def fit' --glob '*.py'",
    "rg --files",
    "find . -name '*.py' -not -path './.venv/*'",
    "cd /repo && ls -la && wc -l model.py",
    `grep -rn "val_mape" onyx`,
    "ls src/*.py",
  ])
    expect([c, judge(r, "Bash", sh(c))]).toEqual([c, ok])
  // still only its own onyx research command
  expect(judge(r, "Bash", sh("cat x && onyx research propose y")).allow).toBe(false)
})

test("a read that writes or runs a program is refused", () => {
  for (const c of [
    "sed -i 's/a/b/' model.py",
    "sed -n '1w out' model.py",
    "sed -n 'e python x.py' model.py",
    "sed -n -f script.sed model.py",
    "sed -n '1,5p' -i model.py",
    "find . -exec python {} ;",
    "find . -name x -delete",
    "find . -fprint out",
    "find * -name x",
    "rg --pre python x",
    "rg --pre=./x.sh y",
    "rg $FLAGS x",
    "python model.py",
    "sort -o x y",
  ])
    expect([c, onlyReads(c)]).toEqual([c, false])
  const r = readOnlyTools(["onyx research aspect *"])
  expect(judge(r, "Bash", sh("cat x > y")).allow).toBe(false)
  expect(judge(r, "Bash", sh("cat $(python x.py)")).allow).toBe(false)
  // an agent with no Read reads nothing with its shell
  expect(
    judge(
      { tools: ["Bash"], allow: ["Bash(onyx research *)"], mode: "dontAsk" },
      "Bash",
      sh("cat x")
    ).allow
  ).toBe(false)
})

test("a worker's edits stay in its directories", () => {
  const w = { ...workerTools(), writable: ["/runs/r/worktrees/a", "/runs/r/experiments/a"] }
  const patch = (...files: string[]) => ({
    command: `*** Begin Patch\n${files.map((f) => `*** Update File: ${f}\n@@\n-a\n+b`).join("\n")}\n*** End Patch`,
  })
  expect(
    patchPaths(
      "*** Begin Patch\n*** Add File: x.py\n+1\n*** Update File: y.py\n*** Move to: z.py\n"
    )
  ).toEqual(["x.py", "y.py", "z.py"])
  expect(judge(w, "apply_patch", patch("model.py"))).toEqual(ok)
  expect(
    judge(w, "apply_patch", patch("/runs/r/worktrees/a/sub/x.py", "/runs/r/experiments/a/notes.md"))
  ).toEqual(ok)
  for (const f of [
    "../b/model.py",
    "/home/u/.bashrc",
    "/runs/r/worktrees/ab/y",
    "/runs/r/state.json",
  ])
    expect([f, judge(w, "apply_patch", patch("model.py", f)).allow]).toEqual([f, false])
  expect(
    judge(w, "apply_patch", { command: "*** Begin Patch\n*** Move to: ../../x\n" }).allow
  ).toBe(false)
  expect(judge(w, "apply_patch", { command: "*** Begin Patch\n*** End Patch" }).allow).toBe(false)
  // rules with nowhere named (Claude Code's own, say) don't limit where
  expect(judge(workerTools(), "apply_patch", patch("/anywhere/x"))).toEqual(ok)
})
