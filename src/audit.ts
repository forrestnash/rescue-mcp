import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface AuditEntry {
  ts: string;
  tool: string;
  params_redacted: Record<string, unknown>;
  exit_code?: number;
  duration_ms?: number;
  remote_addr: string;
}

let _logPath = "";

export function initAudit(logPath: string): void {
  _logPath = logPath;
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
  } catch {
    // best effort
  }
}

export function appendAudit(entry: AuditEntry): void {
  if (!_logPath) return;
  try {
    appendFileSync(_logPath, JSON.stringify(entry) + "\n");
  } catch {
    // best effort — never crash on audit failure
  }
}
