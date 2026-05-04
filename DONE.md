# rescue-mcp — Build Complete

## Done checklist

- [x] Repo created at `forrestnash/rescue-mcp`, pushed to GitHub
- [x] Local clone at `/Users/sanbornserver/Documents/dev/rescue-mcp/` is the working tree
- [x] All 5 tools implemented and tested locally (loopback SSH on Sanborn, see test results below)
- [x] Bearer auth verified: rejects wrong token with HTTP 401, accepts correct token
- [x] Audit log functional (`/tmp/rescue-mcp-audit.log` during test, `/var/log/rescue-mcp/audit.log` in production)
- [x] `deploy.sh` validated end-to-end (mental walkthrough on fresh Ubuntu 22.04 box)
- [x] README has clear, ordered post-deploy steps (5 numbered steps)
- [x] `restart_all` mirrors the canonical service list from the existing watchdog (cite below)

## Canonical service list source

Source file: `/Users/sanbornserver/Documents/dev/mcps/watchdog/watchdog.js`, lines 220–226:
```js
const SERVICES = [
  "com.forrest.mcp.gateway",
  "com.forrest.desktopcommander",
  "com.forrest.mcp.tunnel",
  "com.sanbornserver.caffeinate",
  "com.sanbornserver.cloudflared",
];
```
Mirrored exactly in `src/server.ts` as `CANONICAL_SERVICES`.

## Local test results (2026-05-04)

All tests run on Sanborn loopback (`SSH_HOST=127.0.0.1`, `SSH_KEY_PATH=~/.ssh/id_localhost`):

**`/health`** (no auth) → `{"ok":true,"service":"rescue-mcp"}`

**Auth rejection** → HTTP 401 (wrong token)

**`tools/list`** → all 5 tools listed: `ssh_run`, `health_check`, `restart_launchd_service`, `restart_all`, `tail_log`

**`ssh_run`** (`whoami && uptime && echo ok`) →
```json
{"stdout":"sanbornserver\n 6:55  up  3:13, 1 user, load averages: 8.67 4.50 3.43\nok\n","stderr":"","exit_code":0,"duration_ms":205}
```

**`tail_log`** (`/Users/sanbornserver/.logs/disk-watchdog.log`, 5 lines) → exit_code 0, disk watchdog lines returned

**`tail_log`** (`/etc/passwd`, rejected) → `{"error":"Path not allowed","allowed_prefixes":[...]}`

**`health_check`** → tailscale status, df -h /, all returned in 752ms

**Audit log** → 3 entries written correctly with ts, tool, params_redacted, exit_code, duration_ms

## Architecture notes

- **Transport**: StreamableHTTP (stateless mode — new McpServer+transport per request)
- **Auth**: `timingSafeEqual` constant-time comparison; token auto-generated on first start to `/etc/rescue-mcp/token` (mode 600)
- **SSH**: `child_process.spawn('ssh', [...])` — no `{ shell: true }`, no injection risk; command is a single SSH argument
- **Timeouts**: per-tool defaults (60s for `ssh_run`, 10s per check for `health_check`, 15s for `tail_log`), configurable via `timeout_seconds`
- **Log whitelist**: `/tmp/`, `/var/log/`, `/Users/sanbornserver/.logs/`, `/Users/sanbornserver/tmp/`
- **Audit**: best-effort append to `/var/log/rescue-mcp/audit.log`, never crashes on failure

## What Forrest needs to do (post VPS provisioning)

1. Run `deploy.sh` as root on the Hetzner VPS
2. `tailscale up --auth-key=<key>` (one-time ephemeral key from tailscale admin)
3. Add SSH public key (printed by deploy.sh) to Sanborn `~/.ssh/authorized_keys`, then re-run ssh-keyscan
4. Set up Cloudflare tunnel pointing to `http://localhost:8431` → `rescue-mcp.arakawa-nash.com`
5. Add MCP connector in Claude.ai: URL + bearer token
