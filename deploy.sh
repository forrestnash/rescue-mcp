#!/usr/bin/env bash
# deploy.sh — rescue-mcp deploy script for fresh Ubuntu 22.04+ VPS (run as root)
# Idempotent: safe to re-run.
set -euo pipefail

REPO_URL="https://github.com/forrestnash/rescue-mcp.git"
APP_DIR="/opt/rescue-mcp"
APP_USER="rescue-mcp"
CONF_DIR="/etc/rescue-mcp"
LOG_DIR="/var/log/rescue-mcp"
PORT="8431"
SSH_TARGET_HOST="100.92.96.47"
SSH_TARGET_USER="sanbornserver"

echo "═══════════════════════════════════════════════════════"
echo "  rescue-mcp deploy — $(date)"
echo "═══════════════════════════════════════════════════════"

# ── 1. System packages ───────────────────────────────────────────────────────
echo "[1/12] Installing system packages..."
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg openssh-client logrotate jq git

# ── 2. Node.js 20 via NodeSource ─────────────────────────────────────────────
echo "[2/12] Installing Node.js 20..."
if ! node --version 2>/dev/null | grep -q "^v20"; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "  node: $(node --version)  npm: $(npm --version)"

# ── 3. Tailscale ─────────────────────────────────────────────────────────────
echo "[3/12] Installing Tailscale..."
if ! command -v tailscale &>/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
  echo "  Tailscale installed. NOTE: do NOT run tailscale up yet — see next-steps below."
else
  echo "  Tailscale already installed: $(tailscale version 2>/dev/null | head -1)"
fi

# ── 4. cloudflared ───────────────────────────────────────────────────────────
echo "[4/12] Installing cloudflared..."
if ! command -v cloudflared &>/dev/null; then
  ARCH="$(dpkg --print-architecture)"
  CF_DEB="cloudflared-linux-${ARCH}.deb"
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/${CF_DEB}" \
    -o "/tmp/${CF_DEB}"
  dpkg -i "/tmp/${CF_DEB}"
  rm -f "/tmp/${CF_DEB}"
fi
echo "  cloudflared: $(cloudflared --version 2>&1 | head -1)"

# ── 5. Clone / update repo ───────────────────────────────────────────────────
echo "[5/12] Cloning/updating repository..."
if [ -d "${APP_DIR}/.git" ]; then
  git -C "${APP_DIR}" pull --ff-only
else
  git clone "${REPO_URL}" "${APP_DIR}"
fi

# ── 6. Build ──────────────────────────────────────────────────────────────────
echo "[6/12] Installing npm dependencies and building..."
cd "${APP_DIR}"
npm ci 2>&1 | tail -5
npm run build 2>&1 | tail -10
npm prune --omit=dev 2>&1 | tail -5
echo "  Build complete."

# ── 7. SSH key ───────────────────────────────────────────────────────────────
echo "[7/12] Setting up SSH key..."
mkdir -p "${CONF_DIR}"
chmod 700 "${CONF_DIR}"

if [ ! -f "${CONF_DIR}/ssh_id" ]; then
  ssh-keygen -t ed25519 -N "" -C "rescue-mcp@$(hostname)" -f "${CONF_DIR}/ssh_id"
  chmod 600 "${CONF_DIR}/ssh_id"
  chmod 644 "${CONF_DIR}/ssh_id.pub"
  echo "  SSH keypair generated."
else
  echo "  SSH key already exists."
fi

# Populate known_hosts for Sanborn's Tailscale IP
echo "[7b] Scanning ${SSH_TARGET_HOST} for host key..."
ssh-keyscan -H "${SSH_TARGET_HOST}" > "${CONF_DIR}/known_hosts" 2>/dev/null || {
  echo "  WARNING: ssh-keyscan failed (Tailscale not up yet?). Will retry after tailscale up."
  echo "  Run manually: ssh-keyscan -H ${SSH_TARGET_HOST} > ${CONF_DIR}/known_hosts"
}
if [ -s "${CONF_DIR}/known_hosts" ]; then
  chmod 644 "${CONF_DIR}/known_hosts"
  echo "  known_hosts populated."
fi

# ── 8. Bearer token ───────────────────────────────────────────────────────────
echo "[8/12] Setting up bearer token..."
if [ ! -f "${CONF_DIR}/token" ]; then
  TOKEN="$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=')"
  printf '%s\n' "${TOKEN}" > "${CONF_DIR}/token"
  chmod 600 "${CONF_DIR}/token"
  echo "  Bearer token generated and saved to ${CONF_DIR}/token"
else
  echo "  Bearer token already exists."
fi
TOKEN="$(cat "${CONF_DIR}/token")"

# ── 9. System user ────────────────────────────────────────────────────────────
echo "[9/12] Creating system user..."
if ! id "${APP_USER}" &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "${APP_USER}"
  echo "  User '${APP_USER}' created."
else
  echo "  User '${APP_USER}' already exists."
fi

# Fix ownership
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
chown root:root "${CONF_DIR}"
chmod 700 "${CONF_DIR}"
chown root:"${APP_USER}" "${CONF_DIR}/token" "${CONF_DIR}/ssh_id"
chmod 640 "${CONF_DIR}/token" "${CONF_DIR}/ssh_id"
[ -f "${CONF_DIR}/known_hosts" ] && chmod 644 "${CONF_DIR}/known_hosts"

# ── 10. Log directory ─────────────────────────────────────────────────────────
echo "[10/12] Setting up log directory..."
mkdir -p "${LOG_DIR}"
chown "${APP_USER}:${APP_USER}" "${LOG_DIR}"
chmod 750 "${LOG_DIR}"

# logrotate config
cat > /etc/logrotate.d/rescue-mcp <<'LOGROTATE'
/var/log/rescue-mcp/audit.log {
    daily
    rotate 30
    compress
    missingok
    notifempty
    create 0640 rescue-mcp rescue-mcp
}
LOGROTATE
echo "  logrotate configured."

# ── 11. Systemd unit ──────────────────────────────────────────────────────────
echo "[11/12] Installing systemd service..."
cat > /etc/systemd/system/rescue-mcp.service <<UNIT
[Unit]
Description=rescue-mcp — off-host SSH MCP server for Sanborn
After=network.target
Wants=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node ${APP_DIR}/dist/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rescue-mcp
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=SSH_HOST=${SSH_TARGET_HOST}
Environment=SSH_USER=${SSH_TARGET_USER}
Environment=SSH_KEY_PATH=${CONF_DIR}/ssh_id
Environment=SSH_KNOWN_HOSTS=${CONF_DIR}/known_hosts
Environment=TOKEN_PATH=${CONF_DIR}/token
Environment=AUDIT_LOG_PATH=${LOG_DIR}/audit.log
# Restrict capabilities
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${LOG_DIR}
ReadOnlyPaths=${CONF_DIR} ${APP_DIR}

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable rescue-mcp
systemctl restart rescue-mcp
echo "  rescue-mcp.service enabled and started."

# Give it 2s then check
sleep 2
if systemctl is-active --quiet rescue-mcp; then
  echo "  Service is RUNNING."
else
  echo "  WARNING: Service not running. Check: journalctl -u rescue-mcp -n 30"
fi

# ── 12. Done — next steps ─────────────────────────────────────────────────────
SSH_PUBKEY="$(cat "${CONF_DIR}/ssh_id.pub")"

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Done. Now do these 4 things on your laptop or phone:"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "① JOIN TAILSCALE (on this VPS, run):"
echo "  tailscale up --auth-key=<YOUR_TAILSCALE_AUTH_KEY>"
echo "  (Get a one-time key at https://login.tailscale.com/admin/settings/keys)"
echo ""
echo "② ADD SSH PUBLIC KEY to Sanborn (~/.ssh/authorized_keys):"
echo "  --- copy this line ---"
echo "${SSH_PUBKEY}"
echo "  --- end ---"
echo "  On Sanborn run: echo '${SSH_PUBKEY}' >> /Users/sanbornserver/.ssh/authorized_keys"
echo "  Then re-run this script (or manually): ssh-keyscan -H ${SSH_TARGET_HOST} > ${CONF_DIR}/known_hosts"
echo "  Test: sudo -u ${APP_USER} ssh -i ${CONF_DIR}/ssh_id -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${CONF_DIR}/known_hosts ${SSH_TARGET_USER}@${SSH_TARGET_HOST} 'echo ok'"
echo ""
echo "③ BEARER TOKEN (save this — it won't be shown again):"
echo "  ${TOKEN}"
echo ""
echo "④ SET UP CLOUDFLARE TUNNEL:"
echo "  a. cloudflared tunnel login"
echo "  b. cloudflared tunnel create rescue-mcp"
echo "  c. cloudflared tunnel route dns rescue-mcp rescue-mcp.arakawa-nash.com"
echo "  d. Create /etc/cloudflared/config.yml:"
cat <<CFYML
     tunnel: <TUNNEL_ID_from_step_b>
     credentials-file: /root/.cloudflared/<TUNNEL_ID>.json
     ingress:
       - hostname: rescue-mcp.arakawa-nash.com
         service: http://localhost:${PORT}
       - service: http_status:404
CFYML
echo "  e. cloudflared service install && systemctl start cloudflared"
echo "  f. Add MCP connector in Claude.ai:"
echo "     URL:   https://rescue-mcp.arakawa-nash.com/mcp"
echo "     Token: <bearer token from step ③>"
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Logs: journalctl -u rescue-mcp -f"
echo "  Audit: tail -f ${LOG_DIR}/audit.log"
echo "════════════════════════════════════════════════════════════════"
