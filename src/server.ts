import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "./config.js";
import { initAudit, appendAudit } from "./audit.js";
import { runSsh, SshConfig } from "./ssh.js";

// ─── Canonical service list (mirrored from watchdog.js) ────────────────────
// Source: /Users/sanbornserver/dev/mcps/watchdog/watchdog.js
// lines 220-226, SERVICES array
const CANONICAL_SERVICES = [
  "com.forrest.mcp.gateway",
  "com.forrest.desktopcommander",
  "com.forrest.mcp.tunnel",
  "com.sanbornserver.caffeinate",
  "com.sanbornserver.cloudflared",
] as const;

// ─── Log whitelist ──────────────────────────────────────────────────────────
const LOG_PATH_PREFIXES = [
  "/tmp/",
  "/var/log/",
  "/Users/sanbornserver/.logs/",
  "/Users/sanbornserver/tmp/",
];

// ─── Startup ────────────────────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error(`[rescue-mcp] uncaughtException: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[rescue-mcp] unhandledRejection: ${reason}`);
});

const cfg = loadConfig();
const sshCfg: SshConfig = {
  host: cfg.sshHost,
  user: cfg.sshUser,
  keyPath: cfg.sshKeyPath,
  knownHostsPath: cfg.sshKnownHostsPath,
};
initAudit(cfg.auditLogPath);

// ─── Bearer auth helper ─────────────────────────────────────────────────────
function checkBearer(req: Request): boolean {
  const authHeader = req.headers["authorization"] ?? "";
  const incoming = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";
  if (!incoming) return false;
  // Constant-time comparison
  try {
    const a = Buffer.from(incoming);
    const b = Buffer.from(cfg.token);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─── MCP server factory ──────────────────────────────────────────────────────
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "rescue-mcp",
    version: "1.0.0",
  });

  // ── Tool: ssh_run ──────────────────────────────────────────────────────────
  server.tool(
    "ssh_run",
    "Run an arbitrary shell command on Sanborn Server via SSH. Returns stdout, stderr, exit_code, duration_ms.",
    {
      command: z.string().describe("Shell command to execute on Sanborn Server"),
      timeout_seconds: z
        .number()
        .min(1)
        .max(300)
        .optional()
        .describe("Execution timeout in seconds (default 60, max 300)"),
    },
    async ({ command, timeout_seconds }, extra) => {
      const timeoutMs = Math.min((timeout_seconds ?? 60) * 1000, 300_000);
      const start = Date.now();
      const result = await runSsh(command, timeoutMs, sshCfg);
      appendAudit({
        ts: new Date().toISOString(),
        tool: "ssh_run",
        params_redacted: { command_length: command.length },
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        remote_addr: (extra as { remoteAddr?: string }).remoteAddr ?? "unknown",
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ── Tool: health_check ─────────────────────────────────────────────────────
  server.tool(
    "health_check",
    "Returns a structured health summary of Sanborn Server: tailscale status, disk usage, launchd service states, gateway/relay health, and recent system log lines.",
    {},
    async (_args, extra) => {
      const start = Date.now();

      const checks = await Promise.all([
        runSsh("tailscale status 2>&1 | head -20", 10_000, sshCfg),
        runSsh("df -h /", 10_000, sshCfg),
        runSsh(
          "launchctl print gui/$(id -u) 2>/dev/null | grep -E 'com\\.forrest|com\\.sanbornserver' | head -40",
          10_000,
          sshCfg
        ),
        runSsh(
          "curl -s --max-time 5 http://localhost:8430/health 2>&1 || echo 'not reachable'",
          10_000,
          sshCfg
        ),
        runSsh(
          "curl -s --max-time 5 http://localhost:8420/health 2>&1 || echo 'not reachable'",
          10_000,
          sshCfg
        ),
        runSsh(
          "tail -n 20 /var/log/system.log 2>/dev/null || echo 'not available'",
          10_000,
          sshCfg
        ),
      ]);

      const [tsStatus, diskDf, launchd, claudeRelay, mcpGateway, syslog] =
        checks;

      const summary = {
        tailscale_status: tsStatus.stdout.trim() || tsStatus.stderr.trim(),
        disk_df_root: diskDf.stdout.trim(),
        launchd_services: launchd.stdout.trim(),
        claude_relay_8430: claudeRelay.stdout.trim(),
        mcp_gateway_8420: mcpGateway.stdout.trim(),
        system_log_tail: syslog.stdout.trim(),
        check_duration_ms: Date.now() - start,
      };

      appendAudit({
        ts: new Date().toISOString(),
        tool: "health_check",
        params_redacted: {},
        duration_ms: summary.check_duration_ms,
        remote_addr: (extra as { remoteAddr?: string }).remoteAddr ?? "unknown",
      });

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  // ── Tool: restart_launchd_service ──────────────────────────────────────────
  server.tool(
    "restart_launchd_service",
    "Restart a single launchd service on Sanborn Server using launchctl kickstart -k. Tries GUI domain first, falls back to system domain.",
    {
      name: z
        .string()
        .describe(
          "Full launchd service name (e.g. com.forrest.mcp.gateway) or short suffix"
        ),
    },
    async ({ name }, extra) => {
      const start = Date.now();
      const uid = 504; // sanbornserver UID

      // Try gui domain first, then system domain
      const kickstartCmd = [
        `launchctl kickstart -k gui/${uid}/${name} 2>&1`,
        `&& echo "KICKED:gui/${uid}/${name}"`,
        `|| (launchctl kickstart -k system/${name} 2>&1 && echo "KICKED:system/${name}")`,
        `|| echo "FAILED:could not kickstart ${name}"`,
      ].join(" ");

      const kickResult = await runSsh(kickstartCmd, 15_000, sshCfg);

      // 2s delay then verify
      await new Promise((r) => setTimeout(r, 2000));
      const verifyCmd = [
        `launchctl print gui/${uid}/${name} 2>/dev/null | grep -E 'state|pid' | head -5`,
        `|| launchctl print system/${name} 2>/dev/null | grep -E 'state|pid' | head -5`,
        `|| echo 'service not found in launchctl'`,
      ].join(" ");
      const verifyResult = await runSsh(verifyCmd, 10_000, sshCfg);

      const result = {
        service: name,
        kickstart_output: kickResult.stdout.trim(),
        kickstart_stderr: kickResult.stderr.trim(),
        kickstart_exit_code: kickResult.exit_code,
        verification: verifyResult.stdout.trim(),
        duration_ms: Date.now() - start,
      };

      appendAudit({
        ts: new Date().toISOString(),
        tool: "restart_launchd_service",
        params_redacted: { name },
        exit_code: kickResult.exit_code,
        duration_ms: result.duration_ms,
        remote_addr: (extra as { remoteAddr?: string }).remoteAddr ?? "unknown",
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ── Tool: restart_all ──────────────────────────────────────────────────────
  server.tool(
    "restart_all",
    `Restart all canonical Sanborn services using launchctl kickstart -k. Mirrors the exact service list from the watchdog: ${CANONICAL_SERVICES.join(", ")}.`,
    {},
    async (_args, extra) => {
      const start = Date.now();
      const uid = 504; // sanbornserver UID

      const results: Array<{
        service: string;
        ok: boolean;
        target: string;
        output: string;
        duration_ms: number;
      }> = [];

      for (const service of CANONICAL_SERVICES) {
        const svcStart = Date.now();
        const cmd = [
          `launchctl kickstart -k gui/${uid}/${service} 2>&1`,
          `&& echo "TARGET:gui/${uid}/${service}"`,
          `|| (launchctl kickstart -k system/${service} 2>&1 && echo "TARGET:system/${service}")`,
        ].join(" ");

        const r = await runSsh(cmd, 12_000, sshCfg);
        const combined = r.stdout + r.stderr;
        const targetMatch = combined.match(/TARGET:([\w/]+)/);

        results.push({
          service,
          ok: r.exit_code === 0,
          target: targetMatch?.[1] ?? "unknown",
          output: combined.trim(),
          duration_ms: Date.now() - svcStart,
        });
      }

      appendAudit({
        ts: new Date().toISOString(),
        tool: "restart_all",
        params_redacted: {},
        duration_ms: Date.now() - start,
        remote_addr: (extra as { remoteAddr?: string }).remoteAddr ?? "unknown",
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ results, total_duration_ms: Date.now() - start }, null, 2),
          },
        ],
      };
    }
  );

  // ── Tool: tail_log ─────────────────────────────────────────────────────────
  server.tool(
    "tail_log",
    "Tail a log file on Sanborn Server. Path must be under /tmp/, /var/log/, /Users/sanbornserver/.logs/, or /Users/sanbornserver/tmp/.",
    {
      path: z.string().describe("Absolute path to log file on Sanborn Server"),
      lines: z
        .number()
        .min(1)
        .max(500)
        .optional()
        .describe("Number of lines to return (default 50, max 500)"),
    },
    async ({ path: logPath, lines = 50 }, extra) => {
      const start = Date.now();

      // Whitelist check
      const allowed = LOG_PATH_PREFIXES.some((prefix) =>
        logPath.startsWith(prefix)
      );
      if (!allowed) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Path not allowed",
                allowed_prefixes: LOG_PATH_PREFIXES,
                path: logPath,
              }),
            },
          ],
          isError: true,
        };
      }

      const safeLines = Math.min(lines, 500);
      // Use printf to safely construct the path without shell injection
      // (logPath is validated by whitelist above, but still avoid injection)
      const escapedPath = logPath.replace(/'/g, "'\\''");
      const cmd = `tail -n ${safeLines} '${escapedPath}' 2>&1`;
      const result = await runSsh(cmd, 15_000, sshCfg);

      appendAudit({
        ts: new Date().toISOString(),
        tool: "tail_log",
        params_redacted: { path: logPath, lines: safeLines },
        exit_code: result.exit_code,
        duration_ms: Date.now() - start,
        remote_addr: (extra as { remoteAddr?: string }).remoteAddr ?? "unknown",
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                path: logPath,
                lines_requested: safeLines,
                exit_code: result.exit_code,
                output: result.stdout,
                stderr: result.stderr || undefined,
                duration_ms: Date.now() - start,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server;
}

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Auth middleware — applied to /mcp only
function requireBearer(req: Request, res: Response, next: () => void): void {
  if (!checkBearer(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// Health endpoint (no auth — just confirms the server is up)
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "rescue-mcp", ts: new Date().toISOString() });
});

// MCP endpoint — stateless: new transport + server per request
app.all("/mcp", requireBearer, async (req: Request, res: Response) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on("finish", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
    console.error("[rescue-mcp] request error:", err);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(cfg.port, "127.0.0.1", () => {
  console.error(
    `[rescue-mcp] Listening on 127.0.0.1:${cfg.port}  ssh→${cfg.sshUser}@${cfg.sshHost}`
  );
});
