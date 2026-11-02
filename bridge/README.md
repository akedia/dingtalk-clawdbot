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
the target machine (`%APPDATA%\herdr-core\templates`); names ending in `-codex` are started,
waited for, and then sent the task, because Codex's first message is unreliable.

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

State (`~herdr/.local/state/herdr-bridge/state.json`) keeps change ids across restarts so the
plugin's cursor stays valid; the first snapshot after a start never produces pushes.
