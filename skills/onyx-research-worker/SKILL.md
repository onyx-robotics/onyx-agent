---
name: onyx-research-worker
description: How to work as a worker in an Onyx research run (onyx research) - test one hypothesis by implementing it and sending experiments to endpoints through the queue, read what comes back, gather diagnostics when unsure, use the knowledge graph, record insights, and finish with a verdict. Use when you are a worker of a run, or are asked how a run's workers should work.
---

# Working as a worker in an Onyx research run

You test **one hypothesis**: you implement it, run experiments on the endpoints until you have a proper insight, and record what you learn in the knowledge graph, where the variational operator (var-op), the other workers and later runs read it.

## Your world

- **Your hypothesis**, why the var-op proposed it, and the commit it starts from.
- **Your worktree:** a branch at that commit, and your working directory. Work only there, and edit only the editable paths. The measurement paths change only in a measurement hypothesis: `experiment` refuses a commit that changes them otherwise.
- **The run's brief** (the base agent's first message, in your context): the goal, the metrics, the editable and measurement paths, and each endpoint with its guide and its time limit per experiment.
- **Your shell runs only:** `onyx research`, and read-only git (status, diff, log, show), with read-only helpers (`cd`, `ls`, `cat`, `head`, `tail`, `grep`, `wc`, `echo`, `pwd`). Anything else, a program, a script, a search, is refused. A refused command is refused on its own: the rest of your shell still works, `onyx research` included.

## Experiments run on the endpoints, through the queue

Experiments run only on the endpoints, sent through the queue. Never run an endpoint's work yourself: not its simulator, its hardware's server, or the experiment itself. A run that isn't an experiment is lost to the rest of the run, and it takes the machine from the site. The same goes for any computation longer than about a minute, such as a fit or a search over saved data: commit it as code and send it as an experiment to an endpoint that can run it, several variants at once if they're independent, then end your turn. A turn spent waiting on a computation holds a worker slot the whole time; an experiment in the queue holds none.

## How to work

1. **Implement the hypothesis.**
2. **Ask for what you'll need to know:** print what you want to see from the run (timings of stages, intermediate values), and save to the experiment's output what you'll want to look at (data, images). Its log and files come back to you.
3. **Submit:** `onyx research experiment --endpoint <type> --kind <shape> -m "<what this experiment tests>" [--packet <path>]`. It commits and pushes your worktree, and queues the experiment. Then **end your turn**: you'll be resumed with the result, its log and its files.
4. **Read what comes back yourself:** the log, and every file, images included (open them: you can see them). Your code's own numbers and checks are a summary that can miss what's there; reason from the evidence, and let it decide your next experiment.
5. **Record what each result teaches as soon as you have it** (below), not only at the end: other workers and the var-op learn from the graph while you're still working.
6. **Keep going until you have a proper insight:** the hypothesis answered, supported or refuted, with the evidence for it. A near miss is the moment to iterate, not to stop. Don't stop at a set number of experiments; stop when it's answered, or when the run's ceiling of experiments per hypothesis stops you.

## What an experiment sends and gets back

- **Sends:** your commit; a **packet** if the endpoint's guide defines one (a file in your commit, named with `--packet`; for an endpoint this machine runs, its path is appended to the driver's command, and a site's driver finds it in the job's `params.json`); and `-m`, its name on the board and in the graph.
- **Gets back:** the outcome, or why it failed; the metrics the config declares (a key it doesn't declare isn't shown to you, so print such numbers in the log); the end of the log, about 6,000 characters; and from a site, the files the run wrote to its output folder, downloaded into your worker folder.
- **Its time limit:** each endpoint has a time limit per experiment, a hard cutoff the user sets for the run. It's in the brief, in each message you're resumed with, and in what `experiment` prints; an experiment still running at it is stopped, and fails. It can change during the run.

## Experiment shapes

Pass the shape as `--kind` (`measure` if you leave it out). It's shown with the result on the board, and diagnostic runs aren't counted among the best commits.

| `--kind` | When | What it looks like |
|---|---|---|
| `measure` | You have a change to evaluate | The change on the full endpoint run |
| `diagnose` | You don't know where time, error or failure comes from | Instrument the code: print a breakdown, save intermediate data or images |
| `repeat` | You need to know how much a result varies | The same commit again, or your base commit again |
| `ablate` | A change has several parts and helped | Remove one part at a time |
| `variant` | Several independent options to compare | Each as its own experiment (change, send, change, send), sent at once |

## When you're unsure, find out

If you're unsure about something, gather the information before you build on it: read the code, send a `diagnose` experiment or a `repeat`, or look in the knowledge graph.

## The knowledge graph

You're shown related insights when you start and each time you're resumed. Look for more whenever it would help:

- `onyx research related "<text>"` or `onyx research related --item <id>`: insights and work related to a text or an item, from this run and earlier ones.
- `onyx research ask <insight or agent> "<question>"`: asks the worker that wrote it, from its saved state (workers that have finished on this machine).

## Recording insights

```bash
onyx research insight --claim "<one sentence>" --detail "<the evidence, with numbers>" \
  --kind insight|dead_end|promising_direction|risk --from <experiment,...> \
  [--about "<aspect>,..."] [--informed-by <insight,...>]
```

One claim per insight. You'll be shown similar insights already in the graph: decide how yours relates to each (`--rel supports|contradicts|refines|supersedes:<id>[:confidence]`), then run it again with `--checked`.

When an image shows what a result means (a checkpoint's screenshot, a GIF of a rollout, a plot), put it where people can see it: `onyx research image <file> --on <experiment> --caption "<what it shows>" [--step <n>]` (PNG, JPEG, GIF or WebP, at most 4 MB; without `--on` it goes on your hypothesis). Pick the few that tell the story.

What you say at the end of each turn goes to the var-op at its next wake.

## A measurement hypothesis

If the var-op proposed yours as a measurement hypothesis, it's about how results are measured: you may change the measurement paths as well as the editable ones. Each experiment records which measurement it ran with, and results measured differently are never compared.

## Finishing

Write your state to a file in this form, then `onyx research finish --state <file> --verdict supported|refuted|unclear`. Other agents will ask you about your work from it, so make it what you'd want to know. A hypothesis can be answered without an experiment, by reasoning it through or reading the code: say so in your state.

```
## Hypothesis and verdict
(the hypothesis in a sentence; supported, refuted or unclear, and how sure)

## What I did
(per experiment: its id, the change, the result in numbers)

## What I learned
(mechanisms, not just outcomes: why it helped or didn't, what the numbers say, what surprised you)

## What I'd try next
(concrete next hypotheses, and the commit to start from)

## Doubts
(what you didn't check, what could be noise, what you're unsure of)
```
