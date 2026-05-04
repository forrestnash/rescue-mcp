import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

export interface Config {
  token: string;
  port: number;
  sshHost: string;
  sshUser: string;
  sshKeyPath: string;
  sshKnownHostsPath: string;
  auditLogPath: string;
}

export function loadConfig(): Config {
  const port = parseInt(process.env.PORT ?? "8431", 10);
  const sshHost = process.env.SSH_HOST ?? "100.92.96.47";
  const sshUser = process.env.SSH_USER ?? "sanbornserver";
  const sshKeyPath = process.env.SSH_KEY_PATH ?? "/etc/rescue-mcp/ssh_id";
  const sshKnownHostsPath =
    process.env.SSH_KNOWN_HOSTS ?? "/etc/rescue-mcp/known_hosts";
  const auditLogPath =
    process.env.AUDIT_LOG_PATH ?? "/var/log/rescue-mcp/audit.log";
  const tokenPath = process.env.TOKEN_PATH ?? "/etc/rescue-mcp/token";

  let token: string;

  if (process.env.RESCUE_TOKEN) {
    token = process.env.RESCUE_TOKEN;
  } else if (existsSync(tokenPath)) {
    token = readFileSync(tokenPath, "utf8").trim();
  } else {
    token = randomBytes(48).toString("base64url");
    const dir = path.dirname(tokenPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
    process.stderr.write(
      `\n[rescue-mcp] Generated new bearer token:\n  ${token}\n  (saved to ${tokenPath})\n\n`
    );
  }

  return { token, port, sshHost, sshUser, sshKeyPath, sshKnownHostsPath, auditLogPath };
}
