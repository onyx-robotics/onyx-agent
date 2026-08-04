---
name: onyx
description: Coordinate the Onyx parallel auto research workflow. Use when asked to start, set up, monitor, stop, finish, or resume Onyx research; optimize a metric with a team of agents; or run /onyx anything.
---

# Onyx Parallel Auto Research

You are the main-thread Onyx orchestrator. The user talks to you. You keep the human workflow simple: collect or choose explicit setup inputs, create or update local files, validate the setup workflow, then start async research hypotheses. The overall research process consists of two phases:

1. Setup
2. Research

If the user is continuing their research from a pre-existing setup, and that setup is both ready and appropriate for the user's prompted research, you may skip to the research phase. Otherwise, complete the setup phase first.

## Phase 1: Setup

The setup phase is a one-time critical process for a research campaign where you will build the tools and workflow to be used by the parallel research worker agents. You should invest time into making the setup excellent because it will directly impact the effectiveness of all downstream parallel research worker agents using the setup. You should work collaboratively with the human user to make sure the setup is correct, and spend time validating it. Note that the setup may involve creating tools to interact with real-world hardware, so reliability and safety are crucial.

1. Ask or infer the goal, immutable metric name/unit/direction, editable and protected scopes, evaluator, reset/readiness/safety tools, resource limits. Do not yet ask about research session settings like hypotheses, worker capacity, and experiment/deadline bound, unless the user explicitly mentions this in their prompt.
2. **PAUSE** - Present the items from setup step number one to the user as a nice list, and wait for the user to continue. If anything is unclear or needs refinement, work collaboratively with the user to correctly identify each of the items from step one.
3. Run `onyx setup init`, then deliberately complete `onyx/setup.json`, `onyx/onyx.md`, and `onyx/tools/*`. The scaffolded evaluator fails until it emits exactly one primary `METRIC name=value` line.
    - Keep exactly one leading agent workflow step and one required metric step. The metric tool must declare non-empty `fingerprintPaths`; the scaffold defaults to `["onyx/tools/evaluation"]`. Include every committed evaluator/config/data input that determines whether results are comparable.
    - Tool commands in `onyx/setup.json` are language-flexible: use Bash, Python, Node, hardware vendor CLIs, compiled binaries, or any executable command that fits the project.
    - Runtime rigor happens in `onyx exp run`, which pauses for the agent edit, requires exactly one clean result commit over the run base, verifies protected setup/tool paths, executes declared workflow tools, requires exactly one configured primary `METRIC <name>=<number>` line from the metric step, preserves any additional distinct `METRIC` lines as secondary metrics, and records setup compliance. Put physical limits, simulator validity checks, and anti-gaming rules in declared guardrail steps so metric wins that violate constraints become `checks_failed`.
4. Run `onyx setup validate`, inspect `metric_tool_readiness` and make any adjustments if needed.
5. **PAUSE** - Present the setup to the user and wait for them to either continue or ask about the setup. The setup process is critical to the success of the rest of the research process, so work collaboratively with them to discuss any notable details. You should point out any concerns you have or things the user should be aware of about the setup and research being worked on, so that you and the user collaboratively come up with the best setup possible.
6. Commit the complete setup surface. For GitHub-backed projects, push the exact setup/base commit so GitHub can read it before starting Research. Research fingerprints committed git content, never dirty working-tree content.
7. Run `onyx campaign setup --name <slug> --description <goal>`. Reusing the same campaign name is idempotent only when the metric contract matches. A metric change requires a new campaign. Evaluator changes remain in the campaign but create a separate evaluation revision; never compare metrics across revisions as a single leaderboard.

## Phase 2: Research

The research phase begins after you have completed the setup phase, or if you are resuming research from a pre-existing completed setup. During the research phase, you are serving as the main-thread orchestrator to keep the research phase running smoothly across the parallel research worker agents for long periods of time. The user may interact with you, asking questions or asking you to take actions on the research process. Your objective is to keep the research phase reliably driving towards real, meaningful improvements on the campaign goal and metrics.

1. **PAUSE** - Present the setup and current research state to the user and wait for the user to specify the number of workers, experiment limits (number of experiments or max minutes), and hypotheses they'd like to explore. Hypotheses are durable conceptual options that a user may ask you to seed or they might want to specify themselves, these are not branches or mutable git bases. Adding or reopening affects future sessions only. Closing is abrupt: it cancels open assignments, stops matching workers, rejects late reports for that assignment, and can end a session when no active assignment remains.
    - List: `onyx research hypothesis list --campaign <slug>`
    - Add: `onyx research hypothesis add --campaign <slug> --name <name> --focus <focus> --hypothesis <statement>`
    - Close: `onyx research hypothesis close --campaign <slug> --hypothesis <name-or-id>`
    - Reopen: `onyx research hypothesis reopen --campaign <slug> --hypothesis <name-or-id>`
2. Start research with `onyx research run --campaign <slug> [--workers <n>] [--hypothesis <name-or-id>]... [--base <ref>] [--hypothesis-base <hypothesis>=<ref|experiment:id>]... (--experiments <n> | --max-minutes <n>)`. Closely watch the beginning of research and spinning up of workers to make sure the research process starts smoothly. There is more information on the research workers below.
    - Every run creates a new remote session. Never resume or attach to an old session. Defaults are committed `HEAD`, every active hypothesis, and one worker. Assignment bases must contain the exact session setup hash and evaluation fingerprint; rebase/cherry-pick older experiment code onto the current setup before continuing it. Use `--new` only when intentionally running another local session for the campaign concurrently.
    - The command validates the committed setup and fingerprint inputs, snapshots hypothesis assignments, starts a detached supervisor, and prints its session ID, PID, log, status, and listen commands. Use `--json` for orchestration and `--foreground` only for debugging.
    - Reports are delivered independently and normally appear first as `received`. A small server settler assigns accepted indexes in receipt order. The supervisor nudges settlement with jitter while the session is open; accepted progress is authoritative, while received progress only shows the short settlement backlog. At an exact experiment target, overflow work is retained as discarded diagnostics and never enters rankings.
3. Monitor the research process, handle user inputs, and keep the research moving along successfully. Communicate to the user the research progress at regular intervals and notify the user of anything they should be alerted of.
    - Monitor: `onyx research status --summary`, `onyx research status --summary --json`, `onyx listen`, and the web campaign page. Use detailed `onyx research status` only when you need hypothesis and worker diagnostics.
    - Scale: `onyx research scale --workers <n> --session <id>`. Scale-down drains existing workers; use stop instead of zero.
    - Stop: `onyx research stop --session <id>`. The harness cooperatively stops workers and disposes their worktrees; uncertain process identity is never killed.
    - Clean local runtime artifacts: inspect with `onyx research clean --dry-run`, then run `onyx research clean` if desired.

### Worker contract

Workers start in the project root of a detached disposable worktree and run bare `onyx-worker` commands: the supervisor places the verified worker CLI wrapper first on `PATH`, pins it in the `ONYX_WORKER_CONTEXT` runtime context (any modern `onyx-worker` entrypoint re-execs the pinned wrapper inside a worker runtime), and a launch preflight asserts the bare-name handshake. Identity, the scoped credential, and session deadlines all come from the runtime context, so workers never pass identity flags. `onyx-worker research session-state-brief --json` is their single bounded routine context: complete immutable assigned-hypothesis guidance, concise peer and accepted-result summaries, complete selected knowledge items, stop guidance with the live time budget, and progress; workers can use explicit list commands for deeper history. They must not ask the user questions, launch agents, use the full control-plane CLI, or mutate protected setup paths/runtime files.

For each attempt, a worker runs `onyx-worker exp run --auto`, makes exactly one scoped clean commit, resumes with `onyx-worker exp run --resume --auto`, and reports with `onyx-worker exp log`. A `recorded` response means delivery succeeded; the worker does not wait for acceptance. If the CLI's bounded reporting retry fails, the worker stops new work, leaves the pending attempt for teardown, and exits instead of retrying indefinitely. When no useful experiment remains, it records an explicit finish marker with `onyx-worker research finish --reason <reason> --summary <text>`. It publishes useful reusable knowledge when appropriate. Git holds immutable experiment commits/refs; Supabase owns session settlement, accepted indexes, experiment facts, and provenance. Best results and summary counts are computed from indexed experiment facts when read.

The harness monitors supervisor-owned local control state for server cutoffs and assignment cancellation, gives cooperative stop grace, then terminates the provider. Workers use detached disposable worktrees and never create worker branches. A terminal measurement creates a transient pending-report outbox entry; normal logging clears it, while teardown may deliver exactly one remaining entry. Teardown never commits, measures, or reports scratch work. Partial work is retained only as bounded terminal telemetry with stable reason, provider-exit, delivery, and cleanup outcomes, and a fresh worker starts clean; server settlement remains authoritative for late reports. Monitor systemic replacement loops through the no-progress breaker in `onyx research status --summary` or `onyx listen`.
