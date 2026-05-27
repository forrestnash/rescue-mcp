/**
 * OAuth 2.1 + PKCE + Dynamic Client Registration for rescue-mcp.
 * Implements: RFC 9728, RFC 8414, RFC 7591, RFC 7636.
 */
import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import {
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────────
const ISSUER = "https://rescue-mcp.arakawa-nash.com";
const DB_PATH =
  process.env.OAUTH_DB_PATH ?? "/var/lib/rescue-mcp/oauth.db";

// ─── DB init ─────────────────────────────────────────────────────────────────
let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      client_id TEXT PRIMARY KEY,
      redirect_uris TEXT NOT NULL,
      token_endpoint_auth_method TEXT NOT NULL,
      grant_types TEXT NOT NULL,
      response_types TEXT NOT NULL,
      client_id_issued_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_codes (
      code TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      scope TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS access_tokens (
      token TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      token TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  return _db;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
  } catch {
    return false;
  }
}

// ─── OAuth token lookup (for bearer validation in /mcp) ──────────────────────
export function lookupOAuthToken(token: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT expires_at FROM access_tokens WHERE token = ?")
    .get(token) as { expires_at: number } | undefined;
  if (!row) return false;
  return row.expires_at > nowSec();
}

// ─── Router ──────────────────────────────────────────────────────────────────
export function buildOAuthRouter(): Router {
  if (!process.env.RESCUE_OAUTH_PASSPHRASE) {
    console.error("[rescue-mcp] WARNING: RESCUE_OAUTH_PASSPHRASE not set — OAuth authorize will always fail");
  }
  const router = Router();

  // 1. Protected Resource Metadata (RFC 9728)
  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: ISSUER,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp:read", "mcp:write"],
    });
  });

  // 2. Authorization Server Metadata (RFC 8414)
  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
      scopes_supported: ["mcp:read", "mcp:write"],
    });
  });

  // 3. Dynamic Client Registration (RFC 7591)
  router.post("/register", (req: Request, res: Response) => {
    const body = req.body as {
      client_name?: string;
      redirect_uris?: string[];
      token_endpoint_auth_method?: string;
      grant_types?: string[];
      response_types?: string[];
    };

    const redirectUris: string[] = body.redirect_uris ?? [];
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris required" });
      return;
    }

    const clientId = randomHex(16); // 32-char hex UUID-like
    const issuedAt = nowSec();
    const db = getDb();
    db.prepare(`
      INSERT INTO clients (client_id, redirect_uris, token_endpoint_auth_method, grant_types, response_types, client_id_issued_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      clientId,
      JSON.stringify(redirectUris),
      body.token_endpoint_auth_method ?? "none",
      JSON.stringify(body.grant_types ?? ["authorization_code"]),
      JSON.stringify(body.response_types ?? ["code"]),
      issuedAt
    );

    res.status(201).json({
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: body.token_endpoint_auth_method ?? "none",
      grant_types: body.grant_types ?? ["authorization_code"],
      response_types: body.response_types ?? ["code"],
      client_id_issued_at: issuedAt,
    });
  });

  // 4a. Authorize GET — render passphrase form
  router.get("/authorize", (req: Request, res: Response) => {
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } = req.query as Record<string, string>;

    // Validate params
    const err = validateAuthorizeParams({ response_type, client_id, redirect_uri, code_challenge, code_challenge_method });
    if (err) {
      res.status(400).send(`<h2>Bad Request</h2><p>${escapeHtml(err)}</p>`);
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderAuthorizeForm({ client_id, redirect_uri, code_challenge, code_challenge_method, state: state ?? "", scope: scope ?? "", error: "" }));
  });

  // 4b. Authorize POST — validate passphrase, issue code, redirect
  router.post("/authorize", express_urlencoded, (req: Request, res: Response) => {
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope, passphrase } =
      req.body as Record<string, string>;

    const err = validateAuthorizeParams({ response_type, client_id, redirect_uri, code_challenge, code_challenge_method });
    if (err) {
      res.status(400).send(`<h2>Bad Request</h2><p>${escapeHtml(err)}</p>`);
      return;
    }

    // Validate passphrase
    const expectedPass = process.env.RESCUE_OAUTH_PASSPHRASE ?? "";
    const passphraseOk = safeCompare(passphrase ?? "", expectedPass);

    if (!passphraseOk) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderAuthorizeForm({ client_id, redirect_uri, code_challenge, code_challenge_method, state: state ?? "", scope: scope ?? "", error: "Invalid passphrase" }));
      return;
    }

    // Issue code
    const code = randomHex(32);
    const db = getDb();
    db.prepare(`
      INSERT INTO auth_codes (code, client_id, redirect_uri, code_challenge, scope, expires_at, used)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(
      code,
      client_id,
      redirect_uri,
      code_challenge,
      scope ?? "mcp:read mcp:write",
      nowSec() + 60
    );

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);
    res.redirect(302, redirectUrl.toString());
  });

  // 5. Token endpoint
  router.post("/token", express_urlencoded, (req: Request, res: Response) => {
    const body = req.body as Record<string, string>;
    const grantType = body.grant_type;

    if (grantType === "authorization_code") {
      handleAuthCodeGrant(body, res);
    } else if (grantType === "refresh_token") {
      handleRefreshTokenGrant(body, res);
    } else {
      res.status(400).json({ error: "unsupported_grant_type" });
    }
  });

  return router;
}

// ─── Token grant helpers ──────────────────────────────────────────────────────
function handleAuthCodeGrant(body: Record<string, string>, res: Response): void {
  const { code, redirect_uri, client_id, code_verifier } = body;
  if (!code || !redirect_uri || !client_id || !code_verifier) {
    res.status(400).json({ error: "invalid_request", error_description: "Missing required params" });
    return;
  }

  const db = getDb();
  const row = db.prepare("SELECT * FROM auth_codes WHERE code = ?").get(code) as {
    client_id: string; redirect_uri: string; code_challenge: string; scope: string; expires_at: number; used: number;
  } | undefined;

  if (!row) {
    res.status(400).json({ error: "invalid_grant", error_description: "Code not found" });
    return;
  }
  if (row.used) {
    res.status(400).json({ error: "invalid_grant", error_description: "Code already used" });
    return;
  }
  if (row.expires_at < nowSec()) {
    res.status(400).json({ error: "invalid_grant", error_description: "Code expired" });
    return;
  }
  if (row.client_id !== client_id) {
    res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch" });
    return;
  }
  if (row.redirect_uri !== redirect_uri) {
    res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
    return;
  }
  if (!verifyPkce(code_verifier, row.code_challenge)) {
    res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
    return;
  }

  // Mark code used
  db.prepare("UPDATE auth_codes SET used = 1 WHERE code = ?").run(code);

  // Issue tokens
  const accessToken = randomHex(32);
  const refreshToken = randomHex(32);
  const now = nowSec();

  db.prepare("INSERT INTO access_tokens (token, client_id, scope, expires_at) VALUES (?, ?, ?, ?)").run(
    accessToken, client_id, row.scope, now + 3600
  );
  db.prepare("INSERT INTO refresh_tokens (token, client_id, scope, expires_at) VALUES (?, ?, ?, ?)").run(
    refreshToken, client_id, row.scope, now + 30 * 86400
  );

  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refreshToken,
    scope: row.scope,
  });
}

function handleRefreshTokenGrant(body: Record<string, string>, res: Response): void {
  const { refresh_token, client_id } = body;
  if (!refresh_token || !client_id) {
    res.status(400).json({ error: "invalid_request", error_description: "Missing required params" });
    return;
  }

  const db = getDb();
  const row = db.prepare("SELECT * FROM refresh_tokens WHERE token = ?").get(refresh_token) as {
    client_id: string; scope: string; expires_at: number;
  } | undefined;

  if (!row) {
    res.status(400).json({ error: "invalid_grant", error_description: "Refresh token not found" });
    return;
  }
  if (row.expires_at < nowSec()) {
    res.status(400).json({ error: "invalid_grant", error_description: "Refresh token expired" });
    return;
  }
  if (row.client_id !== client_id) {
    res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch" });
    return;
  }

  // Invalidate old refresh token
  db.prepare("DELETE FROM refresh_tokens WHERE token = ?").run(refresh_token);

  // Issue new tokens
  const accessToken = randomHex(32);
  const newRefreshToken = randomHex(32);
  const now = nowSec();

  db.prepare("INSERT INTO access_tokens (token, client_id, scope, expires_at) VALUES (?, ?, ?, ?)").run(
    accessToken, client_id, row.scope, now + 3600
  );
  db.prepare("INSERT INTO refresh_tokens (token, client_id, scope, expires_at) VALUES (?, ?, ?, ?)").run(
    newRefreshToken, client_id, row.scope, now + 30 * 86400
  );

  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: newRefreshToken,
    scope: row.scope,
  });
}

// ─── Param validation ────────────────────────────────────────────────────────
function validateAuthorizeParams(p: {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
}): string | null {
  if (p.response_type !== "code") return "response_type must be 'code'";
  if (!p.client_id) return "client_id is required";
  if (!p.redirect_uri) return "redirect_uri is required";
  if (!p.code_challenge) return "code_challenge is required";
  if (p.code_challenge_method !== "S256") return "code_challenge_method must be 'S256'";

  const db = getDb();
  const client = db.prepare("SELECT redirect_uris FROM clients WHERE client_id = ?").get(p.client_id) as
    { redirect_uris: string } | undefined;
  if (!client) return "Unknown client_id";

  const allowed: string[] = JSON.parse(client.redirect_uris);
  if (!allowed.includes(p.redirect_uri)) return "redirect_uri not registered";

  return null;
}

// ─── URL-encoded body parser (for /authorize POST and /token) ─────────────────
function express_urlencoded(req: Request, res: Response, next: () => void): void {
  // Only parse if content-type is application/x-www-form-urlencoded
  // Use express built-in parser
  const ct = req.headers["content-type"] ?? "";
  if (!ct.includes("application/x-www-form-urlencoded")) {
    next();
    return;
  }
  let body = "";
  req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
  req.on("end", () => {
    const parsed: Record<string, string> = {};
    for (const pair of body.split("&")) {
      const [k, v] = pair.split("=");
      if (k) parsed[decodeURIComponent(k.replace(/\+/g, " "))] = decodeURIComponent((v ?? "").replace(/\+/g, " "));
    }
    req.body = { ...req.body, ...parsed };
    next();
  });
}

// ─── Constant-time string compare ────────────────────────────────────────────
function safeCompare(a: string, b: string): boolean {
  if (!b) return false;
  try {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) {
      // Still run timingSafeEqual on padded buffers to avoid length leak
      timingSafeEqual(Buffer.alloc(1), Buffer.alloc(1));
      return false;
    }
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderAuthorizeForm(p: {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
  scope: string;
  error: string;
}): string {
  const fields = [
    ["response_type", "code"],
    ["client_id", p.client_id],
    ["redirect_uri", p.redirect_uri],
    ["code_challenge", p.code_challenge],
    ["code_challenge_method", p.code_challenge_method],
    ["state", p.state],
    ["scope", p.scope],
  ]
    .map(([name, val]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(val)}">`)
    .join("\n    ");

  const errorHtml = p.error
    ? `<p style="color:red;font-weight:bold">${escapeHtml(p.error)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Authorize Claude — rescue-mcp</title>
<style>body{font-family:sans-serif;max-width:400px;margin:80px auto;padding:0 16px}
label{display:block;margin-bottom:8px}input[type=password]{width:100%;padding:8px;font-size:1rem}
button{margin-top:12px;padding:10px 24px;font-size:1rem;cursor:pointer}</style>
</head>
<body>
<h2>Authorize Claude to access rescue-mcp</h2>
${errorHtml}
<form method="post" action="/authorize">
  ${fields}
  <label>Passphrase
    <input type="password" name="passphrase" autofocus required>
  </label>
  <button type="submit">Authorize</button>
</form>
</body>
</html>`;
}
