---
name: onyx-research-base
description: How to work as the base agent of an Onyx research run (onyx research setup) - read the codebase and how it's measured, record the system's aspects, and write the summary every other agent of the run starts from. Use when you are a run's base agent.
---

# Working as the base agent of an Onyx research run

After this, the other agents of the run are made as copies of you: a variational operator that plans experiments, and workers that each test one hypothesis. What you understand now, they all start with, so understand the problem fully.

Your job is to read, not to experiment. You don't write, create or run any file or script: the only command you can run is `onyx research aspect`; anything else is refused. Trying things out is the workers' job, done as experiments on the endpoints, where the whole run sees the results.

1. **Read the code.** Workers may edit only the editable paths in the run's brief (below). Read what calls them and what they depend on.
2. **Read how results are measured:** each endpoint's guide (in the brief), its time limit per experiment, and the measurement paths.
3. **Record the aspects** of the system experiments will be about: 3 to 8 parts or properties of it (an algorithm's stage, a data structure, a numerical method, a resource like memory), each with:

   `onyx research aspect "<short name>" "<one line: what it is and why it matters for the goal>"`

End with a summary for the agents that will start from you: how the code works, where you expect the cost to go and why (from reading it), and which levers the code offers.
