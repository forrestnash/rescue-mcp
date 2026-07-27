import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { SshConfig } from "./ssh.js";

export type TargetName = "sanborn" | "baedeker";

export interface TargetConfig {
  ssh: SshConfig;
  uid: number;
  canonicalServices: readonly string[] | null;
  logPathPrefixes: readonly string[];
}

export interface Config {
  token: string;
  port: number;
  auditLogPath: string;
  targets: Record<TargetName, TargetConfig>;
  /** Legacy fields kept for backwards compat with startup log */
  sshHost: string;
  sshUser: string;
}

export function loadConfig(): Config {
  const port = parseInt(process.env.PORT ?? "8431", 10);
  const sshKeyPath = process.env.SSH_KEY_PATH ?? "/etc/rescue-mcp/ssh_id";
  const sshKnownHostsPath =
    process.env.SSH_KNOWN_HOSTS ?? "/etc/rescue-mcp/known_hosts";
  const auditLogPath =
    process.env.AUDIT_LOG_PATH ?? "/var/log/rescue-mcp/audit.log";
  const tokenPath = process.env.TOKEN_PATH ?? "/etc/rescue-mcp/token";

  // Sanborn SSH config (env overridable for backwards compat)
  const sanbornHost = process.env.SSH_HOST ?? "100.92.96.47";
  const sanbornUser = process.env.SSH_USER ?? "sanbornserver";

  // Baedeker SSH config
  const baedekerHost = process.env.BAEDEKER_SSH_HOST ?? "100.86.235.72";
  const baedekerUser = process.env.BAEDEKER_SSH_USER ?? "forrest";

  const targets: Record<TargetName, TargetConfig> = {
    sanborn: {
      ssh: {
        host: sanbornHost,
        user: sanbornUser,
        keyPath: sshKeyPath,
        knownHostsPath: sshKnownHostsPath,
      },
      uid: 504,
      canonicalServices: [
        "com.forrest.mcp.gateway",
        "com.forrest.desktopcommander",
        "com.forrest.mcp.tunnel",
        "com.sanbornserver.caffeinate",
        "com.sanbornserver.cloudflared",
      ],
      logPathPrefixes: [
        "/tmp/",
        "/var/log/",
        "/Users/sanbornserver/.logs/",
        "/Users/sanbornserver/tmp/",
      ],
    },
    baedeker: {
      ssh: {
        host: baedekerHost,
        user: baedekerUser,
        keyPath: process.env.BAEDEKER_SSH_KEY_PATH ?? sshKeyPath,
        knownHostsPath: process.env.BAEDEKER_SSH_KNOWN_HOSTS ?? sshKnownHostsPath,
      },
      uid: 501,
      canonicalServices: [
        "com.forrest.cloudflared",
        "com.forrest.mcp.dc",
        "com.forrest.mcp.gateway",
        "com.forrest.ollama",
        "com.forrest.mcp.sleepwatcher",
      ],
      logPathPrefixes: [
        "/tmp/",
        "/var/log/",
        "/Users/forrest/.logs/",
        "/Users/forrest/tmp/",
      ],
    },
  };

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

  return {
    token,
    port,
    auditLogPath,
    targets,
    sshHost: sanbornHost,
    sshUser: sanbornUser,
  };
}
