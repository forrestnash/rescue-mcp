# rescue-mcp

Off-host MCP server that gives Claude SSH-execution capability against **Sanborn Server** (`100.92.96.47`). Deployed on a separate Hetzner VPS so it survives Sanborn outages.

## Architecture

```
Claude.ai ──HTTPS──► rescue-mcp.arakawa-nash.com (Cloudflare Tunnel)
                            │
                   cloudflared ──► localhost:8431 (this server)
                            │
                     Node 20 / TypeScript
                     @modelcontextprotocol/sdk (StreamableHTTP)
                            │
               ssh -i /etc/rescue-mcp/ssh_id ──► Tailscale
                            │
                  100.92.96.47 (Sanborn, sanbornserver)
```

## Tools

| Tool | Description |
|------|-------------|
| `ssh_run` | Run any shell command on Sanborn. `{ command, timeout_seconds? }` |
| `health_check` | Structured health summary: tailscale status, disk, launchd services, relay/gateway health, syslog tail |
| `restart_launchd_service` | Kickstart a single launchd service by name |
| `restart_all` | Kickstart all 5 canonical Sanborn services (mirrors watchdog.js) |
| `tail_log` | Tail a log file (whitelisted paths only) |

**Canonical service list** (mirrored from `watchdog.js`):
- `com.forrest.mcp.gateway`
- `com.forrest.desktopcommander`
- `com.forrest.mcp.tunnel`
- `com.sanbornserver.caffeinate`
- `com.sanbornserver.cloudflared`

## Auth

Bearer token in `Authorization: Bearer <token>` header. Constant-time comparison. Token auto-generated on first start, saved to `/etc/rescue-mcp/token` (mode 600).

## Post-Deploy Steps (ordered)

Run `deploy.sh` as root on the VPS, then follow the 4-step output exactly:

### 1. Join Tailscale
```bash
tailscale up --auth-key=<YOUR_ONE_TIME_KEY>
```
Get a key at https://login.tailscale.com/admin/settings/keys (Ephemeral: No, Reusable: No).

### 2. Add SSH public key to Sanborn
```bash
# On Sanborn (ssh in or use existing MCP):
echo '<pubkey from deploy output>' >> /Users/sanbornserver/.ssh/authorized_keys
```
Then back on the VPS, repopulate `known_hosts`:
```bash
ssh-keyscan -H 100.92.96.47 > /etc/rescue-mcp/known_hosts
```
Test the connection:
```bash
sudo -u rescue-mcp ssh \
  -i /etc/rescue-mcp/ssh_id \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/etc/rescue-mcp/known_hosts \
  sanbornserver@100.92.96.47 'echo ok'
```

### 3. Record the bearer token
The deploy script prints it once. Save it — you need it for step 4.

### 4. Set up Cloudflare Tunnel
```bash
cloudflared tunnel login
cloudflared tunnel create rescue-mcp
cloudflared tunnel route dns rescue-mcp rescue-mcp.arakawa-nash.com
```
Create `/etc/cloudflared/config.yml`:
```yaml
tunnel: <TUNNEL_ID>
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: rescue-mcp.arakawa-nash.com
    service: http://localhost:8431
  - service: http_status:404
```
```bash
cloudflared service install
systemctl start cloudflared
```

### 5. Add to Claude.ai
In Claude.ai → Settings → Connectors → Add MCP:
- **URL:** `https://rescue-mcp.arakawa-nash.com/mcp`
- **Token:** `<bearer token from step 3>`

## Testing locally (on Sanborn)

```bash
cd /Users/sanbornserver/Documents/dev/rescue-mcp
npm install && npm run build

# Use loopback SSH (requires id_localhost key)
export SSH_HOST=127.0.0.1
export SSH_KEY_PATH=~/.ssh/id_localhost
export SSH_KNOWN_HOSTS=~/.ssh/known_hosts
export TOKEN_PATH=/tmp/rescue-mcp-test-token
export AUDIT_LOG_PATH=/tmp/rescue-mcp-audit.log
npm start &

# Get the token
TOKEN=$(cat /tmp/rescue-mcp-test-token)

# Test tools/list
curl -s -X POST http://localhost:8431/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq .

# Test health_check
curl -s -X POST http://localhost:8431/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"health_check","arguments":{}}}' | jq .

# Test ssh_run
curl -s -X POST http://localhost:8431/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ssh_run","arguments":{"command":"whoami && uptime"}}}' | jq .

# Verify auth rejection
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8431/mcp \
  -H "Authorization: Bearer wrong" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# Should print: 401
```

## Monitoring

```bash
# Service logs
journalctl -u rescue-mcp -f

# Audit log
tail -f /var/log/rescue-mcp/audit.log | jq .

# Health endpoint (no auth required)
curl http://localhost:8431/health
```
