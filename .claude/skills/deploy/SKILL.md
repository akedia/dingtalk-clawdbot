---
name: deploy
description: |
  Deploy the DingTalk plugin to production server via Git push + pull + gateway restart.
  Handles the full deploy cycle with proper systemd environment variables.
  Triggers: "deploy", "push and deploy", "update server",
  "部署", "推送部署", "更新服务器"
---

# Deploy DingTalk Plugin

Push code to GitHub, pull on remote server, and restart the Gateway.

## IMPORTANT: Git deployment, NOT npm

Remote server uses a Git clone. **Do NOT use** `openclaw plugins update dingtalk`（会覆盖为 npm 版本）.

## Step 1: Rebuild dist bundle (REQUIRED if any .ts changed)

OpenClaw >= 2026.7.1 loads the plugin from the compiled `dist/index.js` bundle
(`openclaw.extensions` entry), NOT from TypeScript sources. **Any TS change that
is not rebuilt into dist/index.js will be silently ignored at runtime.**

```bash
cd "e:\dingtalk-clawdbot"
npx -y esbuild index.ts --bundle --platform=node --target=node22 --format=esm --outfile=dist/index.js --external:dingtalk-stream --external:zod
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

## Step 4: Pull on Remote + Restart Gateway

```bash
ssh root@172.20.90.45 "sudo -u clawd bash -c '
  cd /home/clawd/.openclaw/extensions/dingtalk && git pull
' && sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw gateway restart"
```

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
- Remote plugin path: `/home/clawd/.openclaw/extensions/dingtalk/`
- Do NOT use `su - clawd`（missing systemd session）
- Do NOT use `pkill` or `kill` to manage gateway
- Do NOT use `openclaw plugins update dingtalk`（overwrites Git with npm）
- Do NOT edit server-side .ts files as hotfixes — since 2026.7.1 the runtime loads
  `dist/index.js`; server TS edits are silently ignored. Fix locally, rebuild, deploy.
- `~/.openclaw/npm/node_modules/@yaoyuanchao/dingtalk` on the server is a SYMLINK to
  the git checkout (required by 2026.7.1 plugin convergence adoption) — never replace
  it with a real npm install
