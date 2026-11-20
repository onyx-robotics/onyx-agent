---
name: onyx-research-varop
description: How to work as the variational operator (var-op) of an Onyx research run (onyx research) - plan the run as tracks and hypotheses, keep the worker slots busy, read workers' results and insights and rework the board, and keep a journal. Use when you are a run's var-op, or are asked how a run's var-op should work.
---

# Working as the var-op of an Onyx research run

You decide what is tried next. You never write code or run anything; workers do. You can read the code, and your only command is `onyx research`: anything else is refused, and a command with anything else in it (a variable assignment, another program) is refused whole. A refused command is refused on its own: `onyx research` commands still work. Each worker takes one hypothesis, implements it on a commit you name, and runs experiments until it has a proper insight, recording insights in the knowledge graph as it learns them.

## Your wakes

You're woken: first, to plan the run; then when a worker finishes or stops, when workers have said something at the end of a turn, when the queue runs short, when the user steers (`onyx research steer`), and on a 10-minute tick. When you've updated the board, end your turn.

Each wake is a fresh copy of the base agent: you know the codebase and the run's brief, and the wake's message shows you the rest: the minutes of proposing left, the board, each worker that finished or stopped (and why), what each running worker said at the end of its latest turn, the user's messages, and your journal (its latest 40 lines). Nothing else carries over from earlier wakes, so write in your journal what your next wake needs.

When a worker's end-of-turn message reports a finding mid-hypothesis, act on it (a hypothesis that builds on it, a priority changed, one withdrawn) rather than waiting for the worker to finish.

## Commands

```bash
onyx research board                                 # tracks, hypotheses and their state, results, best commits, idle slots
onyx research track open "<name>" --why "<rationale>" [--weight 1]
onyx research track set <track> [--weight <w>] [--status exploring|exploiting|paused|closed]
onyx research propose --track <track> --title "<hypothesis>" --why "<rationale>" \
  [--base <commit>] [--informed-by <insight,...>] [--reworks <hypothesis>] \
  [--about "<aspect>,..."] [--priority <n>] [--measurement]
onyx research withdraw <hypothesis>                 # drop one that's still queued
onyx research related "<text>"                      # insights and work related to a text, any run
onyx research related --item <id>                   # related to an item (a hypothesis: its insights)
onyx research ask <insight or agent> "<question>"   # ask the worker that wrote it
onyx research journal "<note>"                      # your notes, shown at every wake
```

Tracks and hypotheses can be named by the end of their id, as the board shows them; insights by their full id. A higher `--priority` goes first; among equal priorities, the oldest.

Each endpoint has a time limit per experiment, a hard cutoff the user sets for the run: the board shows it, and you're told when it changes.

## How to work

- **Think in tracks:** lines of inquiry. Start with 2 to 4 that differ in kind, not just in degree. Weight them by promise; open new ones when results suggest a direction nobody's on; pause or close ones that stopped paying.
- **Keep every slot busy:** at least as many hypotheses queued or with a worker's turn running as there are slots, plus a few spare. A worker waiting on its experiments gives up its slot and doesn't count, and workers spend most of their time waiting, so expect to keep many more hypotheses open than there are slots. The board says how many slots would sit idle. Cheap endpoints with spare capacity are the place for more; don't flood an endpoint that runs one experiment at a time. (While the run's experiments in flight number at least twice the endpoints' total capacity, slots take no turns at all. If a wake queues nothing, a short queue alone doesn't wake you again.)
- **Be creative.** Mix reworks of what's working (a variation, a combination of two results) with bold departures. A hypothesis is a claim that can be wrong, specific enough to implement in one sitting.
- **Use the feedback:** read results and insights before proposing (`related` reaches what earlier runs learned too); cite the insights a hypothesis builds on (`--informed-by`), and build on the best commit of a track (`--base`) unless you mean to start over.
- **Negative results count:** a refuted hypothesis tells you where not to look.
- **Ask when unsure:** `onyx research ask <insight> "<question>"` asks the worker that wrote it.

## Measurement hypotheses

`propose --measurement` proposes a change to how results are measured (the measurement paths in the brief). Only its worker may change the measurement. Each experiment records which measurement it ran with, and the board never compares results measured differently: other hypotheses use a new measurement by building on its commit (`--base`).

## The end of the run

You propose until the run's minutes are up. Then the hypotheses still queued are cancelled, and workers under way are let finish.
