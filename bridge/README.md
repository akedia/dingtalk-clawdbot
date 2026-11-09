# herdr-bridge

The DingTalk plugin's `/hd` commands and agent pushes go through this small HTTP service.
It runs on the gateway host as its own Linux user, owns the `hc` client and the SSH keys to
the agent machines, and offers only fixed operations (list, read, send, keys, interrupt,
new-from-template, kill, changes, digest) on `127.0.0.1` behind a bearer token. There is no
`hc exec` or file access through it.

## Install (gateway host, as root)

```bash
useradd -m -s /bin/bash herdr && chmod 700 /home/herdr
loginctl enable-linger herdr                      # systemd user manager, so hc's core outlives shells
# run everything for herdr from its home, with its user bus:
U=$(id -u herdr); cd /home/herdr
alias as-herdr="sudo -u herdr XDG_RUNTIME_DIR=/run/user/$U DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$U/bus PATH=/home/herdr/.local/bin:/usr/bin:/bin"
as-herdr sh -c 'curl -fsSL https://releases.herdr.dev/core/install.sh | sh'
as-herdr ssh-keygen -t ed25519 -N "" -f /home/herdr/.ssh/id_ed25519
```

Authorize `/home/herdr/.ssh/id_ed25519.pub` on each agent machine (Windows admins:
`C:\ProgramData\ssh\administrators_authorized_keys` unless sshd_config drops that Match block),
then add them. hc does not relay a machine's own machines, so add every one directly:

```bash
as-herdr hc machine add user@dev-host --name dev
as-herdr hc machine add user@other-host --name v172
```

Config `~herdr/.config/herdr-bridge/config.json` (mode 600):

```json
{
  "port": 8377,
  "token": "<48 hex chars; the same value goes to channels.dingtalk.herdr.token>",
  "self": "p2host",
  "notifyStates": ["blocked", "error", "done", "turn_end", "exited"],
  "machines": {
    "dev": { "defaultTemplate": "worker-codex",
             "projects": { "x3analyze": { "path": "E:\\x3analyze", "space": "<herdr-app space id on dev>" } } }
  }
}
```

`space` is optional: with it, agents started by `/hd new` appear as a new tab in that Herdr
space (`herdr-app ls` shows the ids; strip the `machine/` prefix). Templates are resolved on
the target machine (`%APPDATA%\herdr-core\templates`). Names ending in `-codex` get the role
rules put in front of the task (Codex templates carry no role text). The task goes as the
template's first message; if hc reports "still starting" (it typed nothing), the bridge waits
for the agent and sends it once. Codex templates should pass `-c tui.animations=false`: an
animated terminal-title spinner during Codex's startup work counts as output and keeps hc
from ever seeing it settle. Any other unsent first message is reported back, not retried.

The bridge is a copy outside the plugin checkout; after changing `herdr-bridge.mjs`, install
it and restart the service (see the deploy skill, step 4b).

Service `~herdr/.config/systemd/user/herdr-bridge.service`:

```ini
[Service]
WorkingDirectory=/home/herdr
ExecStart=/usr/bin/node /home/herdr/herdr-bridge/herdr-bridge.mjs
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
```

```bash
as-herdr systemctl --user daemon-reload
as-herdr systemctl --user enable --now herdr-bridge
as-herdr journalctl --user -u herdr-bridge -f
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8377/health
```

### Agent Hub tasks (`/hd task`)

Add `hub` to each machine whose Agent Hub should take tasks (absolute paths on that machine;
the hc core's own `python` may be the Windows Store stub, so name the interpreter):

```json
"machines": {
  "v172": { "...": "...", "hub": { "python": "C:/Users/<you>/.pyenv/pyenv-win/versions/3.12.9/python.exe",
                                    "script": "D:/x3analyze/qa/agent-hub/hub.py" } }
}
```

The bridge then runs only that hub.py, through `hc exec --on <machine>`, with a fixed set of
subcommands (contexts, list, show, submit, followup, pause, resume, cancel, decide, advance,
outbox, ack-notice) and checked arguments. Every `hubPollSeconds` (default 30) it runs
`advance` (one safe step per open task: dispatch, harvest a report, or run the independent
validation once per revision) and turns each outbox notice into a `task` change before
acknowledging it; a notice already recorded is never pushed twice. Each machine keeps its own
Hub database, worktrees and validation logs; register contexts there with `hub.py register`.

### x3 Mark (`/mark`)

Add `mark` to the machine that runs x3analyze's `qa/mark/mark.py` (absolute paths on that machine; `ssh` is the
`user@host` herdr's key already reaches, `inbox` must exist there):

```json
"v172": { "...": "...", "mark": { "python": "C:/Users/<you>/.pyenv/pyenv-win/versions/3.12.9/python.exe",
                                   "script": "D:/x3analyze/qa/mark/mark.py",
                                   "ssh": "<you>@<host>", "inbox": "E:/x3-artifacts/marks/inbox" } }
```

`/mark/new` writes the attachments and a `mark.json` (note, voice text, role/server/env/live, each checked) into a private
temp folder, `scp -r` it into the inbox, then runs `mark.py submit <inbox>/<id>` through `hc exec`; mark.py starts the
investigation in the background and the call returns at once. Only `/mark/new` accepts a large body (attachments as
base64, 40 MB raw at most). The other routes (ls, show, ask, cancel) and the poll (`status --json --pending`, then `ack`)
run fixed mark.py subcommands with checked ids. Every `markPollSeconds` (default 30) finished marks, failures and
follow-up answers become `mark` changes, recorded once per event even if an ack fails.

State (`~herdr/.local/state/herdr-bridge/state.json`) keeps change ids across restarts so the
plugin's cursor stays valid; the first snapshot after a start never produces pushes.
