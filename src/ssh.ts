import { spawn } from "node:child_process";

export interface SshResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

export interface SshConfig {
  host: string;
  user: string;
  keyPath: string;
  knownHostsPath: string;
}

export function runSsh(
  command: string,
  timeoutMs: number,
  cfg: SshConfig
): Promise<SshResult> {
  return new Promise((resolve) => {
    const start = Date.now();

    const args = [
      "-i", cfg.keyPath,
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${cfg.knownHostsPath}`,
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=5",
      "-o", "ServerAliveCountMax=2",
      `${cfg.user}@${cfg.host}`,
      command,
    ];

    const child = spawn("ssh", args);
    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (exitCode: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exit_code: exitCode, duration_ms: Date.now() - start });
    };

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill("SIGKILL");
        resolve({
          stdout,
          stderr: stderr + "\n[ssh_run: timed out]",
          exit_code: -1,
          duration_ms: Date.now() - start,
        });
      }
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => finish(code ?? -1));
    child.on("error", (err) => {
      stderr += `\n[spawn error: ${err.message}]`;
      finish(-1);
    });
  });
}
