# Setting up a site

A **site** is a machine at your lab that runs Onyx jobs on your hardware: rigs, benches,
builders, simulators. It runs `onyx-site`, a service that asks onyx-app for work over HTTPS,
runs each job with a **driver** you write for your hardware, and keeps the result files on the
machine. This guide takes one site from nothing to running jobs, as an ordinary user: no
`sudo`.

## What this guide assumes

| | |
|---|---|
| **Operating system** | **Linux or macOS.** onyx-site uses Unix sockets and process groups, so Windows isn't supported (WSL may work but isn't tested). |
| **Python** | 3.12 or later, and [uv](https://docs.astral.sh/uv/) (or pip). |
| **An account on the machine** | An ordinary user that stays logged in or can keep a service running (step 5). It needs no admin rights, but it does need access to the hardware (below). |
| **Hardware access** | That user can open the devices your drivers use: on Linux, usually membership of `dialout` (serial) or a udev rule (USB). Granting that is a one-time admin task, outside this guide. |
| **Network, outgoing** | HTTPS to onyx-app. onyx-site only ever calls out; nothing needs to reach it for syncing. |
| **Network, incoming** | People's browsers reach the site's file server (port 7443 by default) to download results: your lab network or VPN is enough. A port above 1024 needs no root. |
| **TLS for the file server** | A certificate and key for the address people use (`public_url`). Plain HTTP is for trying it on a laptop only. |
| **Disk** | Room for result files: they stay on the machine, deleted oldest first past `[retention]`. |
| **git** | If jobs fetch code to run (a `git: {url, commit}` prop): git on the machine and read-only access to those repositories. |
| **An Onyx admin** | Someone with the admin role in the organization, to approve the site (step 4), and to load a pack if your drivers need types or metrics of their own outside a research run (step 1). |
| **Drivers** | A driver for each kind of unit: a Python file you write for your hardware (step 7). Not needed to set the site up: every unit starts on the placeholder driver that ships with onyx-site, and shows in onyx-app from the start. |

## 1. Prepare the organization

Every unit a site offers has a **unit type**, which must be an asset type in the org's
registry: onyx-app refuses a site's units if one of them has a type it doesn't know. The metrics
its drivers report must be metrics there too, or onyx-app refuses them (the job still ends, as
`failed` / `invalid`).

**To start, there's nothing to do here:** the built-in `hardware` pack, which every org has,
gives `hardware_system`, `hardware_subsystem` and `hardware_component`, and the site file
`onyx-site init` writes (step 3) uses them. Come back to this step when your drivers report
metrics of their own, or when you want types of your own.

**For a research run's endpoints, there's nothing to do either:** the run adds the types and
metrics its `research.json` names (`onyx research vocabulary <config>` does only that, before the
site starts). Until then a site that offers one of those types retries its sync, and carries on
once they're there.

Otherwise an admin loads a pack that declares them (Admin → Registry):

```yaml
key: bench
version: 1
label: Motor bench
requires: [hardware]
types:
  - { key: bench.motor_rig, kind: asset, parent: environment, label: Motor rig }
  - { key: bench.speed_test, kind: activity, parent: control_test, label: Speed test }
properties:
  - { key: bench.final_rpm, label: Final speed, type: number, unit: rpm, metric: true }
  - { key: bench.overshoot_pct, label: Overshoot, type: number, unit: "%", metric: true, better: lower }
```

An org's own pack names everything `<pack>.<key>`, so a driver reports `bench.final_rpm`, not
`final_rpm`.

## 2. Install onyx-site

As the user that will run it:

```bash
uv tool install onyx-site   # or: pip install --user onyx-site
onyx-site --version
```

uv puts `onyx-site` in `~/.local/bin`, with a Python of its own: your drivers run on it.

The site's files live in your home directory, where onyx-site looks for them by default: the site
file at `~/.config/onyx-site/site.toml`, its state in `~/.local/state/onyx-site`. (Root, and a
service user whose site is already in `/etc/onyx-site` and `/var/lib/onyx-site`, keep those;
`--site`, `--state-dir`, `ONYX_SITE_CONFIG` and `ONYX_SITE_STATE_DIR` point anywhere else.)

Keep the state folder's path short: the local control socket lives there, and macOS limits a
socket's path to about 100 characters.

## 3. Write the site file

```bash
onyx-site init
```

It says what it does:

```
onyx-site init
  created ~/.config/onyx-site/  (the site file's folder)
  created ~/.local/state/onyx-site/  (the state folder, mode 0700: the site's key, its journal, the jobs' folders)
  wrote   ~/.config/onyx-site/site.toml  (onyx-app: https://dev.onyxresearch.ai; site name: "bench-pc")
  no environment variables needed: onyx-site finds these by default
next:
  1. uncomment one unit in ~/.config/onyx-site/site.toml, and give it your own id
  2. onyx-site enrol
  3. onyx-site run
```

The site file is ready to use. Its `[site]` section names the site: this machine's hostname, or
`onyx-site init --name "Bench lab"`; edit it any time before you enrol.
The file already points at onyx-app (`[site].server`; `--server` sets another) and holds
commented examples of units, one per kind (below). Two things in it are yours to set before real
use: `[policy].max_deadline_s` is 60 seconds, so set it to your longest job; and the file server
(`[files]`) is off until you give it a certificate, so jobs run but their files can't be
downloaded yet (the file has the lines to uncomment).

The examples:

| Example | Unit type | Fidelity |
|---|---|---|
| a robot, a rig, a test stand | `hardware_system` | hardware |
| a simulated robot | `hardware_system` | sim |
| a subsystem on its own (an arm, a drivetrain) | `hardware_subsystem` | hardware |
| a component on a bench (a motor, an encoder) | `hardware_component` | hardware |

Those types come with onyx-app's built-in `hardware` pack, so every org has them. **Uncomment one**
(its `[drivers.…]` and its `[unit_types.…]` block) and give the unit your own id:

```toml
[drivers.robot]
ref = "onyx_site.drivers.placeholder:Placeholder"
config = { unit_type = "hardware_system", todo = "the driver is being written" }
instances = [{ id = "robot-1" }]

[unit_types.hardware_system]
driver = "robot"
fidelity = "hardware"                    # physical: reset before and after every job
```

A unit type has one fidelity per site, so the real and the simulated robot can't both be
`hardware_system` on one site: use your own pack's types for that (`<pack>.<name>`, step 1).

- **Every unit starts on the placeholder** (`onyx_site.drivers.placeholder:Placeholder`), which
  ships with onyx-site: you don't need a driver yet. Each unit shows in onyx-app as soon as the
  site runs (step 6), offline with its `todo` as the reason, and gets no jobs. When its driver is
  ready, you change `ref` (step 9) and it comes free by itself.
- **Instances**: one per rig. Each gets `config` with its own entry over it as `self.config`, and
  its `id` as `self.id`: yours to choose (`rig-1`, an asset tag…), and how onyx-app and your team
  name the unit. Anything a rig needs of its own (its serial port, its IP address) goes in its
  entry; what they all share goes in `config`.
- **Files**: results stay on this machine. Anyone who opens a job in onyx-app downloads its
  files straight from here through a link that works for ten minutes, so `public_url` must be
  reachable from their browsers. It needs TLS; `insecure_http = true` is for development only.
- **Policy** is the site's own and onyx-app can't loosen it: which unit types run here
  (`unit_types`), how long a run may take, and which repositories a job may fetch code from
  (`[repos.…]`). A job it refuses ends `failed` / `refused` without starting.

The site file `onyx-site init` writes is commented, and the onyx-site [README](https://pypi.org/project/onyx-site/) ("The site file") lists every section.

### Giving the site read access to a repository

When jobs name a commit (a `git: {url, commit, ref}` prop, as research experiments do), the site
fetches it itself, with a credential of its own that can only read. For a GitHub repository, a
deploy key:

```bash
mkdir -p ~/.config/onyx-site/keys && chmod 700 ~/.config/onyx-site/keys
ssh-keygen -t ed25519 -N "" -C "bench-lab site (read-only)" -f ~/.config/onyx-site/keys/project_ro
gh repo deploy-key add ~/.config/onyx-site/keys/project_ro.pub -R you/project -t "bench-lab site (read-only)"
```

(`gh` can run on any computer with the `.pub` file; or add it in the repository's Settings →
Deploy keys, leaving "Allow write access" off.)

The site fetches with `StrictHostKeyChecking=yes`, so its user must already trust GitHub's host
key, or every fetch fails. Take it from GitHub's API rather than a scan of the network:

```bash
gh api meta -q '.ssh_keys[]' | sed 's/^/github.com /' >> ~/.ssh/known_hosts
```

Then name the repository in the site file, by the URL jobs will carry, character for character
(for a research run, its config's `remote`):

```toml
[repos.project]
url = "git@github.com:you/project.git"
ssh_key = "keys/project_ro"               # relative to this file
```

Check it as the site will fetch, and that it can't push:

```bash
export GIT_SSH_COMMAND="ssh -i ~/.config/onyx-site/keys/project_ro -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes"
git ls-remote git@github.com:you/project.git main          # a commit: it can read
git push git@github.com:you/project.git HEAD:refs/heads/x  # from any clone: refused, it can't write
```

For an https URL, use `token_file` instead: a file holding a fine-grained token with read-only
access to that repository's contents.

## 4. Enrol the site

```bash
onyx-site enrol
```

It prints a link and a code:

```
To approve this site-runner, an org admin opens:
  https://app.onyx.dev/device?code=VNXQ-JPZD
and checks the code VNXQ-JPZD.
Waiting for approval…
```

An admin opens the link on any computer and checks that the code matches. Then they pick the
organization, confirm the site's name (it's filled in from the site file's `name`; they can change
it), and approve. The machine stores its key in the state folder's `token` file (mode 0600, only
the site's user can read it) and prints `Enrolled as site Bench lab in …`.

A site enrolled by an older onyx-site may have its key in the OS keyring, which onyx-site no
longer reads: it logs that it has no key and says to run `onyx-site enrol` again.

The key only lets the site run jobs: it can't read or change anything else in Onyx, and it never
appears in the site file, an environment variable or a log. The site replaces it every 30 days
by itself.

## 5. Run it as a service

### Linux: a systemd user service

`~/.config/systemd/user/onyx-site.service`:

```ini
[Unit]
Description=Onyx site-runner
After=network-online.target

[Service]
Environment=ONYX_SITE_CONFIG=%h/.config/onyx-site/site.toml
Environment=ONYX_SITE_STATE_DIR=%h/.local/state/onyx-site
ExecStart=%h/.local/bin/onyx-site run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now onyx-site
loginctl enable-linger "$USER"     # keep it running after you log out, and start it at boot
```

`enable-linger` is allowed for your own user on most distributions. If yours refuses it, an
admin runs it once for you.

### macOS: a launchd agent

`~/Library/LaunchAgents/com.onyx.site.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.onyx.site</string>
  <key>ProgramArguments</key>
  <array><string>/Users/YOU/.local/bin/onyx-site</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ONYX_SITE_CONFIG</key><string>/Users/YOU/.config/onyx-site/site.toml</string>
    <key>ONYX_SITE_STATE_DIR</key><string>/Users/YOU/.local/state/onyx-site</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/Users/YOU/.local/state/onyx-site/service.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.onyx.site.plist
```

A launchd agent runs while you're logged in; for a machine nobody logs in to, enable automatic
login for that user, or ask an admin for a system daemon instead.

Then, on either:

```bash
onyx-site status
```

It only makes outgoing HTTPS requests to onyx-app (no open connections, nothing to allow in for
them); the one thing that listens is the file server.

## 6. See your units in onyx-app

**Admin → Sites** shows the site online (it syncs every few seconds), its version, its units with
their state (free, busy, held, offline) and where its file server is.

Each unit is there already, **offline**, with its placeholder's reason: `waiting for its driver:
the driver is being written`. It gets no jobs, and it isn't quarantined: a unit that has never
been healthy stays offline and is checked every minute, so it comes free by itself once its
driver's health passes. From here on, the site is done: what's left is one driver per kind of
unit.

## 7. Write your driver

A driver is a Python file that tells onyx-site how to run a job on your rig. It lives next to the
site file, in a `drivers` folder:

```
~/.config/onyx-site/
├── site.toml           the site file (step 3)
├── drivers/
│   └── motor_rig.py    your driver
└── tls/
    ├── cert.pem        the file server's certificate (step 3)
    └── key.pem
```

Start from this one: it runs, and passes the check in step 8, before you've touched any
hardware. Save it as `~/.config/onyx-site/drivers/motor_rig.py`, then replace the parts marked
`HARDWARE` with calls to your rig.

```python
"""My motor rig: what onyx-site calls to run a job on it.

Replace the parts marked HARDWARE with calls to your rig (serial, CAN, a vendor library…).
"""

import csv
import json
import threading
from pathlib import Path

from onyx_site import Driver, Health, RunContext, RunResult, Unit, UnitFault


class MotorRig(Driver):
    version = "1.0.0"

    def __init__(self, config=None):
        super().__init__(config)
        self.stopping = threading.Event()  # HARDWARE: open the rig here, once

    def describe(self) -> Unit:
        # what this rig is: its id (from the site file) and its unit type (an asset type in the org)
        return Unit(self.id, self.config["unit_type"])

    def health(self) -> Health:
        # HARDWARE: check the rig answers (open its port, read a status register…)
        return Health(True)

    def run(self, inp: Path, out: Path, ctx: RunContext) -> RunResult:
        params = json.loads((inp / "params.json").read_text())  # the job's props
        kp = float(params.get("kp", 1.0))
        self.stopping.clear()
        rows = []
        t = 0.0
        while t < 5.0 and not ctx.cancelled and not self.stopping.is_set():
            # HARDWARE: send a command, read the sensor; raise UnitFault if the rig misbehaves
            rpm = 1000 * (1 - 1 / (1 + kp * t))
            rows.append((round(t, 2), round(rpm, 1)))
            ctx.progress(rpm=rpm)
            if ctx.wait(0.1):  # sleep, but wake at once on stop
                break
            t += 0.1
        if not rows:
            raise UnitFault("no_data", "the rig returned nothing")
        with (out / "recording.csv").open("w", newline="") as f:  # every file in out/ is kept
            csv.writer(f).writerows([("t", "rpm"), *rows])
        final = rows[-1][1]
        # metric names are the org pack's: <pack>.<key>
        return RunResult(metrics={"bench.final_rpm": final}, conditions={"supply_v": 24.0})

    def stop(self) -> None:
        # HARDWARE: bring the rig to a safe stop; may be called at any time, even twice
        self.stopping.set()

    def reset(self) -> RunResult:
        # HARDWARE: home the rig, before and after every run
        return RunResult()
```

What each part is for:

- **One instance per rig.** The site-runner runs one instance of the driver for each rig the site
  file lists (step 3), each in its own process, and gives it only its own rig's jobs, one at a
  time. So adding a rig is one line there. **`describe()`** says what its rig is.
- **`run()`** runs one job on one rig. The job's settings (its props in onyx-app, such as `kp`)
  are in `inp / "params.json"`. Every file it writes to `out` is kept and downloadable from
  onyx-app, and the `metrics` it returns are recorded on the job, named as the org's pack names
  them (step 1).
- **Waiting:** use `ctx.wait(seconds)`, never `time.sleep`. It wakes the moment someone stops
  the job.
- **Problems:** raise `UnitFault("code", "what happened")` when the rig itself is at fault (it's
  then held until someone looks at it), `JobFault` when the job asked for something wrong, and
  `InfraFault` for anything else.
- **`stop()`** must bring the rig to a safe stop quickly, at any time.
- **`reset()`** homes the rig. It runs before and after every job.

[DRIVERS.md](DRIVERS.md) has the full contract, and the onyx-site [README](https://pypi.org/project/onyx-site/) ("Writing a driver")
how to write a driver in another language instead.

**Libraries your driver needs** (for example `pyserial` for a serial port) go into onyx-site's
Python, not your own. Install onyx-site again with them:

```bash
uv tool install --force --with pyserial onyx-site
```

## 8. Check the driver

Before your driver gets real jobs, run every call against it, including a stop in the middle of
a run. The site file still points the units at the placeholder, so name the driver itself, from
the folder it's in, with a unit's config. With the rig connected:

```bash
cd ~/.config/onyx-site/drivers
onyx-site conformance motor_rig:MotorRig --config '{"unit_type": "bench.motor_rig"}'
```

It should end with `conformance passed`. A `FAIL` line says which call misbehaved: fix the
driver and run it again. `No module named 'motor_rig'` means you aren't in the driver's folder;
`No module named 'serial'` means a library is missing (step 7). After step 9,
`onyx-site conformance motor_rig --from-site` checks it as the site file has it.

## 9. Switch the units to their driver

In the site file, point the entry at the driver instead of the placeholder:

```toml
[drivers.motor_rig]
python_path = ["drivers"]                 # the folder your driver is in (step 7)
ref = "motor_rig:MotorRig"                # its file (without .py) : its class
config = { unit_type = "bench.motor_rig" }
instances = [{ id = "rig-1" }, { id = "rig-2" }]
```

The running service sees the change and restarts those units' instances with the driver. Each
unit comes free on its first health check that passes (within a minute), keeping its id, type and
history. One whose driver's health fails says why, offline, and is still checked every minute.

Submit a test job for one of its unit types, from a script with an API key that has the `jobs`
scope, or with onyx-app's CLI:

```bash
onyx run --on bench.motor_rig --type bench.speed_test --name "first run" --prop kp=2.0 --wait
```

It runs on a free unit; its item in onyx-app shows its status, the unit it ran on, its metrics
and, under its files, the recording your driver wrote.

## Day to day

| To… | Do |
|---|---|
| Take a unit out of service (maintenance, a broken belt) | `onyx-site hold --unit rig-1 --reason "belt"`, then `onyx-site release --unit rig-1` |
| Stop a job now, even with the network down | `onyx-site stop --job <id>`: it's reported `cancelled` |
| See what it's doing | `onyx-site status`, and the service's log (`journalctl --user -u onyx-site`, or the log file on macOS) |
| Replace its key now | `onyx-site rotate` (the old key works ten more minutes) |
| Retire it, or if the machine is compromised | **Revoke** on Admin → Sites: its keys stop at once |
| Reinstall the machine | Enrol again; an admin re-approves it as the same site, and its old keys stop |

A unit whose health check fails shows **offline** with the check's reason and gets no jobs. It's
checked again every minute, and the first check that passes makes it free again.

- **A unit that has been healthy and fails two checks in a row is quarantined:** it isn't checked
  any more, and stays out of service until a person releases it (`onyx-site release --unit <id>`).
- **A unit that has never been healthy** since it was added (its driver isn't there yet, or not
  working yet) **is never quarantined:** it stays offline, with its reason, and comes free by itself
  on its first check that passes. So a unit can be in the site file, and on onyx-app's site page,
  from the start, with a driver whose `health()` says what's still to do.

A job that fails because of the unit puts it on **hold** in onyx-app until someone resumes it
there, since a physical rig may need looking at first.

## When something's wrong

| You see | Likely |
|---|---|
| Admin → Sites says **offline** | The service is down or can't reach onyx-app: `systemctl --user status onyx-site` (or `launchctl list com.onyx.site`), then the log |
| The log says the key is no longer accepted | The site was revoked: enrol again |
| "no local control socket: … path too long" in the log | The state folder's path is too long (step 2); the service still runs, but `hold`, `release` and `stop` can't reach it |
| Jobs end `failed` / `invalid` with "refused its results" | A metric the driver reports isn't in the org's registry (step 1) |
| Jobs end `failed` / `refused` | The site's policy refused them: a unit type it doesn't allow, or a repository it doesn't know |
| A unit never gets jobs | Its unit type isn't an asset type in the org, or the unit is held, offline or quarantined (`onyx-site status`) |
| A driver can't open its device | The user lacks access to it (see the assumptions) |
| You changed the driver and nothing's different | Restart the service (`systemctl --user restart onyx-site`); a change to the site file is picked up by itself |
| Download links don't open | `public_url` isn't reachable from the browser, or its certificate isn't trusted |

## Trying it on a laptop

For Onyx's own developers, in a checkout of the Onyx repository: against a local onyx-app
(`bun run dev` in `typescript/onyx-app`), with the simulated motor rig that ships with onyx-site
and plain HTTP:

```toml
[site]
server = "http://localhost:3000"
state_dir = "state"

[files]
bind = "127.0.0.1:7443"
public_url = "http://localhost:7443"
insecure_http = true

[drivers.sim_motor]
ref = "onyx_site.drivers.sim_motor:SimMotor"
config = { unit_type = "bench.motor_rig", metrics_prefix = "bench." }
instances = [{ id = "rig-1" }, { id = "rig-2" }]

[unit_types."bench.motor_rig"]
driver = "sim_motor"
fidelity = "sim"
```

```bash
cd python/site-runner
uv run onyx-site --site path/to/site.toml enrol   # approve as admin@acme.test
uv run onyx-site --site path/to/site.toml run
```
