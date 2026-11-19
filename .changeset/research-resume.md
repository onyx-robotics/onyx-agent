---
"@onyx-robotics/agent": minor
---

`onyx research run <config> --minutes <n>` resumes a run with that much more time to propose, a run whose time is up included: the workers' turns it cancelled at its end are sent again, and the hypotheses it cancelled leave the board. A run's supervisor leaves the queue when it stops, so its slots are archived rather than left offline. An experiment the supervisor runs itself has its own process group, so its time limit ends whatever the driver started. The setup skill checks whether a machine already is a site before enrolling it, and adds the endpoint to that site instead.
