# Writing a driver

A site-runner (`onyx-site`) manages a site's **resources**: rigs, sim environments, build slots, the GPUs on a computer. It takes jobs from onyx-app and decides which resource runs each one. It also fetches the code a job names, keeps the results, watches each resource's health, and handles holds. What it can't know is how to run a job on *your* resource. That's the **driver**: the code you write, and the only code you write.

A driver is written for **one** resource. The site-runner runs one **instance** of it per resource, each in its own process. An instance only ever deals with its own resource: one job at a time, handed to it by the site-runner when the resource is able to run it.

This page covers what the site-runner sends an instance, how, and what happens from then on. The rest of a site is in [SETUP.md](SETUP.md): the pack, approval, running it as a service. The protocol with onyx-app is in the onyx-site [README](https://pypi.org/project/onyx-site/).

## The driver's world

An instance sees exactly this, and nothing else:

- **Its config:** the driver's shared `config` from the site file, with its own entry from `instances` merged over it. That always includes its `id`, also available as `self.id`.
- **Calls from the site-runner:** `describe`, `health`, `check`, `reset`, `run`, `stop`.
- **For a job:** two folders, `in/` and `out/`, and a `ctx` for logging, progress and stopping.

It never talks to onyx-app, never sees the queue or the other resources, and never handles keys. Who sent a job, and why, is outside its world. All it knows of a job is what's in `in/`.

## Instances

```toml
[drivers.my_computer]
ref = "onyx_site.drivers.local_program:LocalProgram"   # a Python class, module:Class
instances = [                                           # one entry per resource
  { id = "gpu-0", env = { CUDA_VISIBLE_DEVICES = "0" } },
  { id = "gpu-1", env = { CUDA_VISIBLE_DEVICES = "1" } },
]
[drivers.my_computer.config]                            # what every instance gets
unit_type = "mine.computer"
command = ["python3", "train.py"]

[unit_types."mine.computer"]                            # an asset type in the org's registry
driver = "my_computer"
fidelity = "sim"
```

- **One instance per entry,** each in its own process. Each is constructed once with `config` plus its entry, `{"unit_type": …, "command": …, "id": "gpu-0", "env": {…}}`, and kept for as long as the site-runner runs it. So it can hold things between jobs: an open port, a loaded simulator, a warm model. With no `instances` there's one instance, whose id is the driver's name.
- **At start,** and when the site file changes, the site-runner asks each new instance `describe()`, what it is. The answer becomes one of the site's units, offered to onyx-app.
- **A crash** (its process exits) fails the call in flight as an infrastructure fault. The instance is started again on its next call. **A hang** (a call past its time limit) gets its process killed, with the same result. Other instances aren't affected either way.
- **A change to an instance's entry in the site file** (or to the shared config, or the class) restarts that instance. If it's running a job, it restarts once the job ends. A change to your code isn't noticed: restart the site-runner.

`print()` in a Python driver goes to the site-runner's own log; the process's stdout belongs to the protocol. Use `ctx.log()` for a job's log.

## The calls

| Call | When the site-runner makes it | Answer | Limit |
|---|---|---|---|
| `describe()` | When the instance starts | `Unit(id, unit_type, labels, exclusive_group)`: what this resource is | 60 s |
| `health()` | Between jobs (every `health_interval_s`, 60), after each job, after a failure | `Health(ok, reason)`: can it run a job now? | 60 s |
| `check(inp)` *(optional)* | Before a job starts | nothing; raise `JobFault` to refuse the job | the job's deadline |
| `reset()` *(physical resources)* | Before and after every job | `RunResult`: what it did | the deadline before; 300 s after |
| `run(inp, out, ctx)` | To run a job | `RunResult` | the job's deadline |
| `stop()` | At any time during a job: a cancel, the deadline, `onyx-site stop` | nothing | `stop_timeout_s` (10) |

`check` and `reset` are optional: an instance whose class doesn't define one doesn't offer it. A resource is physical when its unit type's `fidelity` is `hardware` or `hil` (or `physical = true`), and a physical resource's driver must offer `reset`.

**The site-runner only hands an instance work it can take.** It never sends a job to a resource that's running one, or that's held, offline or quarantined. While a resource is being reset or health-checked, it isn't offered for jobs. A job that arrives anyway, because onyx-app assigned it off an earlier sync, waits until the check ends and then runs, rather than failing. So `run` never overlaps another `run`, `reset` or `health` on the same instance. Only `stop` can arrive while `run` is in flight, in another thread.

## One job

When onyx-app assigns a job to one of your resources, the site-runner checks it against the site's policy: the unit type, the deadline, and whether its repository is allowed. A refused job never reaches the instance. Then:

**1. It prepares the folders,** under `<state_dir>/work/<job>/<attempt>/`:

```
in/
├── …               the job's commit, if it names one (props.git = {url, commit}),
│                   exported with git archive: its files, no .git
└── params.json     the job's props, exactly as its sender wrote them
out/                empty
driver.log          the job's log, as the instance writes it
```

`params.json` is the job's packet. The site-runner reads only `git` from it, to fetch the commit. Everything else means whatever you and the job's sender agree it means.

**2. It calls the instance:** `check(inp)`, then `reset()` if the resource is physical, then `run(inp, out, ctx)`. Here:

- `inp` is `in/`, so `json.loads((inp / "params.json").read_text())` is the packet;
- `out` is `out/`, where everything you want kept goes;
- `ctx` is the job's context:
  - `ctx.log(line)` writes a line to the job's log;
  - `ctx.progress(name=value)` sends a live number;
  - `ctx.wait(seconds)` sleeps but wakes at once on a stop, and returns True if stopped;
  - `ctx.cancelled` is True once a stop was asked for, or the deadline passed;
  - `ctx.remaining()` is the seconds left;
  - `ctx.params` is the props again.

**3. A stop can come at any time** during `run`. The site-runner sets `ctx.cancelled` and calls `stop()` in another thread. `run` should notice (through `ctx.wait` or `ctx.cancelled`), bring the resource to a safe state and return. If `stop` doesn't return within `stop_timeout_s`, or `run` hasn't returned that long after it, the instance's process is killed. The job is then reported `cancelled`, or `failed` / `job` for the deadline.

**4. What `run` returns becomes the result:**

| `run`… | becomes |
|---|---|
| returns `RunResult(metrics={"mine.loss": 0.12})` | the job's metrics. The names must be metric properties in the org's registry (`<pack>.<key>`), or onyx-app refuses the results and the job ends `failed` / `invalid` |
| returns `RunResult(conditions={"gpu": "A100"})` | the job's props, merged at the top level; 16 KB at most, past which they're kept as a file instead |
| writes files to `out/` | kept on this machine; each is a ref on the job, downloadable through onyx-app (`driver.log` too, as `_onyx/driver.log`) |
| returns `RunResult(valid=False)` | `failed` / `invalid`: it ran but its data can't be trusted. What it left is kept |
| returns normally | `succeeded` |
| raises `JobFault(code, message)` | `failed` / `job`: the job's own fault (bad params, code that crashes). Never retried. `code = "data_invalid"` means `invalid` instead |
| raises `UnitFault(code, message)` | `failed` / `unit`: the resource itself failed. It goes offline (quarantined after two failures in a row, once it has been healthy), and onyx-app holds it until a person resumes it |
| raises `InfraFault(code, message)` | `failed` / `infra`: anything around the job (a network, a missing tool). Retried if the job has retries left |

**5. Afterwards** the site-runner stores `out/` and reports the end to onyx-app, resending it until it's acknowledged, whatever restarts happen. It then resets the resource if it's physical and checks its health, and only after that offers it again.

## Writing one

A Python driver is a class:

```python
from onyx_site import Driver, Health, JobFault, RunContext, RunResult, Unit


class MyRig(Driver):
    version = "1.0.0"

    def __init__(self, config):
        super().__init__(config)  # self.config, and self.id
        ...  # open the resource, once

    def describe(self) -> Unit:
        return Unit(self.id, self.config["unit_type"])

    def health(self) -> Health:
        return Health(True)  # can it run a job now?

    def run(self, inp, out, ctx: RunContext) -> RunResult:
        ...  # read inp, drive the resource, fill out
        return RunResult(metrics={...})

    def stop(self) -> None: ...  # make run() end, safely, now
```

A driver in another language is a **program** answering subcommands instead (`program = "/path"` in the site file), with the instance's config in `ONYX_DRIVER_CONFIG`:
- `describe`
- `health`
- `run --in in/ --out out/ --deadline-s N`
- `stop`
- `reset`
- `check --in in/`

Each subcommand is a fresh process, so a program doesn't stay running between calls, and `stop` has to reach the `run` process itself, for example through a pid file. Exit code 0 means ok, 10 a job fault, 11 a unit fault, 12 infrastructure. Stdout is JSON lines: `{"log": …}`, `{"progress": {…}}`, and `{"result": {…}}` or `{"fault": {"code", "message"}}`. `describe` prints `{"result": {"version": …, "calls": […], "unit": {"id", "unit_type", "labels"}}}`.

## Before the driver: the placeholder

A unit can be in the site file before its driver exists. Give it the shipped placeholder:

```toml
[drivers.my_rig]
ref = "onyx_site.drivers.placeholder:Placeholder"
config = { unit_type = "mine.rig", todo = "the driver is being written" }
instances = [{ id = "rig-1" }]
```

The unit shows in onyx-app as soon as the site runs, offline with `waiting for its driver: <todo>`
as the reason, and gets no jobs. A unit that has never been healthy is never quarantined, so when
the driver is ready and the entry's `ref` points at it, the instance restarts and the unit comes
free on its first health check that passes.

## The example: a slot on this computer

`onyx_site.drivers.local_program` (in the onyx-site package, `onyx_site/drivers/local_program.py`) makes a computer an endpoint. Each instance is a slot, so as many jobs run at once as there are instances, and each slot runs a program from its job's commit. The site file above uses it, with one slot per GPU.

The program runs in `in/`, with these set in its environment:
- `ONYX_IN`: the commit, and the program's working folder
- `ONYX_PARAMS`: the `params.json` there
- `ONYX_OUT`: the `out/` folder, whose contents are kept
- `ONYX_UNIT`: the slot's id
- the slot's `env`

Its output is the job's log. `$ONYX_OUT/metrics.json` (`{"name": number}`) holds the job's metrics. Exit 0 means it succeeded; anything else fails the job, with the end of its output as the reason. With `allow_job_command = true`, a job may name its own command (`props.command`). `stop_grace_s` (15) is how long a stopped program gets between SIGTERM and SIGKILL. It runs code directly, as you, so it's for code you trust.

Read it as a template. Its `run` has the shape most drivers need:
1. start the work
2. stream its output to `ctx.log`
3. wait with `ctx.wait`, so a stop wakes it
4. on a stop, end the work's whole process group
5. turn what came of it into a `RunResult` or a fault

## Common shapes

- **A program, or a simulator, per job:** start it in `run` in its own process group (`start_new_session=True`), and end the group on a stop. Give it more grace than its own cleanup takes, or a kill leaves its children behind.
- **A service each job talks to** (a simulator to connect to, a server): start it in `run` before the job's code, wait until it's ready, point the job's code at it (an environment variable), and stop it in a `finally`. If it's slow to start and safe to reuse, start it once in `__init__` and reset it between jobs instead.
- **The resource is on another machine:** `run` sends the work over SSH (or another channel), streams the output back, and copies the results into `out/`.
- **Resources that can't run at the same time** (two rigs on one power supply): give their instances the same `exclusive_group`. The site-runner then runs at most one of them at a time.
- **A rig that must be homed:** set `fidelity = "hardware"` and write `reset()`. It runs before and after every job.

## Testing

`onyx-site conformance` makes every call against one instance, the way the site-runner would, with no onyx-app:
- `describe`, `health`, and `stop` while idle
- `check`, and `run` on a short job, checking its result
- `run` on a long job, stopped halfway, checking it ends in time
- `reset`, and `health` again

```bash
onyx-site --site site.toml conformance my_computer --from-site --instance gpu-0 \
  --input jobs/short --long-input jobs/long
```

A job folder is what `in/` would be: your commit's files plus a `params.json`. The long one must keep running until it's stopped. Without `--input` and `--long-input`, conformance uses its own sample jobs (a `build.sh` and `{"duration_s": …}`), made for the shipped examples, so a driver that runs your own code needs folders of its own. It should end `conformance passed`.
