---
name: deploy
description: |
  Deploy the DingTalk plugin to production server via Git push + pull + `openclaw plugins reload`.
  Handles the full deploy cycle with proper systemd environment variables.
  Triggers: "deploy", "push and deploy", "update server",
  "部署", "推送部署", "更新服务器"
---

# Deploy DingTalk Plugin

Push code to GitHub, pull on remote server, and hot-reload the plugin (no gateway restart).

Since OpenClaw 2026.10.2 (2026-10-13) the plugin is a **linked install** (`source: path`)
of the git checkout at `/home/clawd/plugins/dingtalk`: doctor, `openclaw update` and
`plugins update --all` skip it, and `plugins reload` swaps the code in place.

## IMPORTANT: Git deployment, NOT npm

Remote server uses a Git clone. **Do NOT use** `openclaw plugins update dingtalk`（会覆盖为 npm 版本）.

## Step 1: Rebuild dist bundle (REQUIRED if any .ts changed)

OpenClaw >= 2026.7.1 loads the plugin from the compiled `dist/index.js` bundle
(`openclaw.extensions` entry), NOT from TypeScript sources. **Any TS change that
is not rebuilt into dist/index.js will be silently ignored at runtime.**

```bash
cd "e:\dingtalk-clawdbot"
npm run build
git add dist/index.js
```

## Step 2: Verify Local State

```bash
git -C "e:\dingtalk-clawdbot" status
git -C "e:\dingtalk-clawdbot" log --oneline -3
```

Ensure all changes (including dist/index.js) are committed before deploying.

## Step 3: Push to GitHub

```bash
git -C "e:\dingtalk-clawdbot" push origin master
```

## Step 4: Pull on Remote + Reload Plugin

```bash
ssh root@172.20.90.45 "sudo -u clawd bash -c '
  cd /home/clawd/plugins/dingtalk && git pull --ff-only &&
  cd ~ && XDG_RUNTIME_DIR=/run/user/1001 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
    timeout 300 openclaw plugins reload dingtalk --json
'"
```

**Before reloading, make sure the gateway is not frozen.** On 2026-10-13 a reload issued
while the main agent DB was running `incremental-vacuum` on the main thread sat queued for
7 minutes, failed with "plugin lifecycle lease … was lost", and left the old instance's
cleanup half-done: every later reload failed with "Previous plugin cleanup failed", core
reported `PluginInstanceUnavailableError` (the DingTalk `message` tool — and thus all cron
pushes — broke, though inbound replies still worked), and only a gateway restart
recovered it. Check first:

```bash
ssh root@172.20.90.45 "tail -c 3000 /tmp/openclaw/openclaw-\$(date +%Y-%m-%d).log | grep -ac 'incremental-vacuum\|liveness heartbeat delayed'"
```

If that is non-zero, wait a few minutes and re-check. If a reload fails anyway, verify with
`openclaw channels status --json` and the log for `PluginInstanceUnavailableError`; if
present, restart the gateway (warm restart reaches `gateway ready` in ~2 minutes, but the
main agent then needs its background DB inspection before it can answer).

The reload receipt lists `sourceDigests.dingtalk`; it changes when new code was picked up.
The old Stream instance is stopped via `abortSignal` before the new one starts. A full
`openclaw gateway restart` also works but costs a 10+ minute cold start plus up to ~15
minutes of main-agent background DB inspection, during which the main agent cannot answer.

## Step 5: Verify Deployment

```bash
# Check gateway status
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw gateway status"

# Check startup logs
ssh root@172.20.90.45 "tail -20 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log" | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        obj = json.loads(line.strip())
        msg = str(obj.get('0', ''))
        if not msg or msg.startswith('{'): continue
        time_str = obj.get('time', '')[:19]
        level = obj.get('_meta', {}).get('logLevelName', '')
        print(f'{time_str} [{level:5s}] {msg}')
    except: pass
"
```

## Critical Rules

- `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` are REQUIRED for gateway commands
- Gateway runs as `clawd` (UID 1001), not root
- Remote plugin path: `/home/clawd/plugins/dingtalk/` (linked install, listed in
  `plugins.load.paths`). Do NOT move it back under `~/.openclaw/extensions/` — 10.x manages
  that directory and a checkout there conflicts with `plugins install -l`
- Do NOT use `su - clawd`（missing systemd session）
- Do NOT use `pkill` or `kill` to manage gateway
- Do NOT use `openclaw plugins update dingtalk`（overwrites Git with npm）
- Do NOT edit server-side .ts files as hotfixes — since 2026.7.1 the runtime loads
  `dist/index.js`; server TS edits are silently ignored. Fix locally, rebuild, deploy.
- The old npm-symlink adoption hack (`~/.openclaw/npm/node_modules/@yaoyuanchao/dingtalk`)
  was removed on 2026-10-13: under 10.x that npm record made doctor report "install
  incomplete", and `doctor --fix` / `openclaw update` would replace the plugin with npm's
  older release. Do not recreate it
- Plugin caches live in `~/.openclaw/dingtalk-cache/` (1.7.18+), not in the checkout
