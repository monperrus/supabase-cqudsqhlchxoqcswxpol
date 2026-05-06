import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Supabase strips /functions/v1 from req.url internally
const FUNCTION_PATH = "/todo-mcp-server";
const PUBLIC_FUNCTION_PATH = "/functions/v1/todo-mcp-server";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResp(body: unknown, status = 200, extra?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors, ...extra },
  });
}

function redirect(url: string) {
  return new Response(null, { status: 302, headers: { Location: url, ...cors } });
}

// ---- Crypto utilities ----

function bytesToB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64urlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function textToB64url(s: string): string {
  return bytesToB64url(new TextEncoder().encode(s));
}

async function sha256b64url(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bytesToB64url(new Uint8Array(buf));
}

function randomB64url(n = 32): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return bytesToB64url(b);
}

async function hmacB64url(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToB64url(new Uint8Array(sig));
}

// Lightweight signed JWT (HS256) — used only for device flow access tokens
async function signJwt(payload: Record<string, unknown>, ttl = 600): Promise<string> {
  const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const now = Math.floor(Date.now() / 1000);
  const h = textToB64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = textToB64url(JSON.stringify({ ...payload, iat: now, exp: now + ttl }));
  const sig = await hmacB64url(`${h}.${p}`, secret);
  return `${h}.${p}.${sig}`;
}

// AES-GCM encrypt plaintext using code_challenge as key material.
// auth_code = encrypt(access_token, key=SHA256(code_challenge))
// Decryption requires code_verifier so the client can compute code_challenge.
async function encryptWithChallenge(plaintext: string, codeChallenge: string): Promise<string> {
  const keyBits = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeChallenge));
  const key = await crypto.subtle.importKey("raw", keyBits, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const out = new Uint8Array(12 + cipher.byteLength);
  out.set(iv);
  out.set(new Uint8Array(cipher), 12);
  return bytesToB64url(out);
}

async function decryptWithVerifier(authCode: string, codeVerifier: string): Promise<string | null> {
  try {
    const codeChallenge = await sha256b64url(codeVerifier);
    const keyBits = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeChallenge));
    const key = await crypto.subtle.importKey("raw", keyBits, { name: "AES-GCM" }, false, ["decrypt"]);
    const combined = b64urlToBytes(authCode);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: combined.slice(0, 12) }, key, combined.slice(12),
    );
    return new TextDecoder().decode(plain);
  } catch { return null; }
}

// ---- OAuth discovery ----

function handleResourceMetadata(req: Request) {
  const base = baseUrl(req);
  return jsonResp({ resource: base, authorization_servers: [base] });
}

function handleAuthServerMetadata(req: Request) {
  const base = baseUrl(req);
  return jsonResp({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

// The Claude Code MCP SDK (Vx1) looks for AS metadata at three paths. For a
// server URL with a non-root pathname it tries (in order):
//   1. origin/.well-known/oauth-authorization-server{pathname}   → 401 (Supabase root)
//   2. origin/.well-known/openid-configuration{pathname}         → 401 (Supabase root)
//   3. origin{pathname}/.well-known/openid-configuration         ← THIS IS US
//
// It never tries origin{pathname}/.well-known/oauth-authorization-server, so we
// must serve an OpenID Connect compatible document at path #3.
// The ti$ Zod schema used by the SDK for OIDC requires: issuer, authorization_endpoint,
// token_endpoint, jwks_uri, subject_types_supported,
// id_token_signing_alg_values_supported, response_types_supported.
function handleOidcMetadata(req: Request) {
  const base = baseUrl(req);
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  return jsonResp({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    // jwks_uri is required by the OIDC schema; point to Supabase's JWKS endpoint.
    jwks_uri: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

async function handleRegister(req: Request) {
  let meta: Record<string, unknown> = {};
  try { meta = await req.json(); } catch { /* no body is fine */ }
  return jsonResp({
    client_id: randomB64url(16),
    client_secret_expires_at: 0,
    redirect_uris: meta.redirect_uris ?? [],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

// Step 1: MCP client → /authorize → stores session in DB, starts Supabase GitHub OAuth
async function handleAuthorize(req: Request): Promise<Response> {
  const p = new URL(req.url).searchParams;
  const codeChallenge = p.get("code_challenge");
  const codeChallengeMethod = p.get("code_challenge_method") ?? "S256";
  const redirectUri = p.get("redirect_uri");
  const state = p.get("state");
  const clientId = p.get("client_id");

  if (!codeChallenge || !redirectUri || p.get("response_type") !== "code") {
    return jsonResp({ error: "invalid_request", error_description: "Missing required params" }, 400);
  }
  if (codeChallengeMethod !== "S256") {
    return jsonResp({ error: "invalid_request", error_description: "Only S256 supported" }, 400);
  }

  // Derive a deterministic supabase code_verifier from code_challenge + server secret.
  const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseCodeVerifier = await hmacB64url(codeChallenge, secret);
  const supabaseCodeChallenge = await sha256b64url(supabaseCodeVerifier);

  // Store all MCP params in DB so redirect_to URL stays short (Supabase allowlist-friendly).
  const db = serviceClient();
  const { data: row, error: dbErr } = await db.from("mcp_auth_codes").insert({
    mcp_code_challenge: codeChallenge,
    mcp_code_challenge_method: codeChallengeMethod,
    mcp_redirect_uri: redirectUri,
    mcp_client_id: clientId,
    mcp_state: state,
    supabase_code_verifier: supabaseCodeVerifier,
  }).select("id").single();

  if (dbErr || !row) {
    return jsonResp({ error: "server_error", error_description: dbErr?.message ?? "DB insert failed" }, 500);
  }

  const callbackUrl = `${baseUrl(req)}/callback`;
  const authUrl = new URL(`${Deno.env.get("SUPABASE_URL")}/auth/v1/authorize`);
  authUrl.searchParams.set("provider", "github");
  authUrl.searchParams.set("redirect_to", `${callbackUrl}?auth_id=${row.id}`);
  authUrl.searchParams.set("code_challenge", supabaseCodeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return redirect(authUrl.toString());
}

// Step 2: Supabase redirects here → exchange Supabase code → encrypt token → redirect to MCP client
async function handleCallback(req: Request): Promise<Response> {
  const p = new URL(req.url).searchParams;
  const authId = p.get("auth_id");
  const supabaseCode = p.get("code");

  if (!authId || !supabaseCode) {
    return new Response("<h1>Error</h1><p>Missing auth_id or code parameter.</p>", {
      status: 400, headers: { "Content-Type": "text/html" },
    });
  }

  const db = serviceClient();
  const { data: row, error: rowErr } = await db.from("mcp_auth_codes")
    .select("*")
    .eq("id", authId)
    .is("used_at", null)
    .single();

  if (rowErr || !row) {
    return new Response("<h1>Error</h1><p>Invalid or expired OAuth session. Please try again.</p>", {
      status: 400, headers: { "Content-Type": "text/html" },
    });
  }

  if (new Date(row.expires_at) < new Date()) {
    return new Response("<h1>Error</h1><p>OAuth session expired. Please try again.</p>", {
      status: 400, headers: { "Content-Type": "text/html" },
    });
  }

  // Exchange Supabase auth code for access_token
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const tokenRes = await fetch(
    `${Deno.env.get("SUPABASE_URL")}/auth/v1/token?grant_type=pkce`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": anonKey,
        "Authorization": `Bearer ${anonKey}`,
      },
      body: JSON.stringify({ auth_code: supabaseCode, code_verifier: row.supabase_code_verifier }),
    },
  );

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return new Response(`<h1>Auth Error</h1><pre>${err}</pre>`, {
      status: 500, headers: { "Content-Type": "text/html" },
    });
  }

  const { access_token } = await tokenRes.json();
  if (!access_token) {
    return new Response("<h1>Error</h1><p>No access token returned.</p>", {
      status: 500, headers: { "Content-Type": "text/html" },
    });
  }

  // Encrypt access_token with code_challenge as key material.
  // Only the MCP client (who holds code_verifier) can decrypt it.
  const authCode = await encryptWithChallenge(access_token, row.mcp_code_challenge as string);

  await db.from("mcp_auth_codes").update({ used_at: new Date().toISOString() }).eq("id", authId);

  const dest = new URL(row.mcp_redirect_uri as string);
  dest.searchParams.set("code", authCode);
  if (row.mcp_state) dest.searchParams.set("state", row.mcp_state as string);

  return redirect(dest.toString());
}

// ---- Device Flow (RFC 8628) ----

function generateDeviceCode(): string {
  // RFC 8628: device_code should be 40-128 chars, unreserved characters
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(32))).substring(0, 40);
}

function generateUserCode(): string {
  // User-friendly code: 8 chars, uppercase + digits, without ambiguous chars (0/O, 1/I/L)
  const chars = "23456789BCDFGHJKMNPQRTVWXYZ";
  let code = "";
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 8; i++) code += chars[arr[i] % chars.length];
  return code.substring(0, 4) + "-" + code.substring(4);
}

async function handleDeviceRequest(req: Request): Promise<Response> {
  const db = serviceClient();
  const deviceCode = generateDeviceCode();
  const userCode = generateUserCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 minutes

  const { error } = await db.from("device_codes").insert({
    device_code: deviceCode,
    user_code: userCode,
    status: "pending",
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  });

  if (error) {
    return jsonResp({ error: "server_error", error_description: error.message }, 500);
  }

  const verificationUrl = `${baseUrl(req)}/verify`;
  return jsonResp({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUrl,
    verification_uri_complete: `${verificationUrl}?user_code=${userCode}`,
    expires_in: 900, // 15 minutes
    interval: 5, // poll every 5 seconds
  });
}

function htmlEscape(str: string): string {
  return str.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function handleVerifyPage(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const userCode = url.searchParams.get("user_code");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Device Authentication</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      max-width: 500px;
      width: 100%;
      padding: 40px;
    }
    h1 {
      font-size: 24px;
      margin-bottom: 12px;
      color: #1f2937;
    }
    p {
      color: #6b7280;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .form-group {
      margin-bottom: 24px;
    }
    label {
      display: block;
      margin-bottom: 8px;
      font-weight: 600;
      color: #374151;
      font-size: 14px;
    }
    input {
      width: 100%;
      padding: 12px;
      border: 2px solid #e5e7eb;
      border-radius: 8px;
      font-size: 16px;
      font-family: monospace;
      letter-spacing: 1px;
      transition: border-color 0.2s;
    }
    input:focus {
      outline: none;
      border-color: #667eea;
    }
    input.prefilled {
      background-color: #f9fafb;
      color: #1f2937;
    }
    button {
      width: 100%;
      padding: 12px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
    }
    button:active {
      transform: translateY(0);
    }
    .error {
      background-color: #fee;
      color: #c33;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 20px;
      display: none;
    }
    .success {
      background-color: #efe;
      color: #3c3;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 20px;
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>✓ Device Authentication</h1>
    <p>Enter the code displayed on your device to authorize access.</p>
    <div class="error" id="error"></div>
    <div class="success" id="success">Authorization successful! You can close this window.</div>
    <form id="form" style="display: none;">
      <div class="form-group">
        <label for="userCode">User Code</label>
        <input type="text" id="userCode" name="userCode" placeholder="XXXX-XXXX" maxlength="9" required style="text-transform: uppercase;">
      </div>
      <button type="submit">Authorize</button>
    </form>
    <div id="loading" style="text-align: center; padding: 20px;">
      <p>Loading...</p>
    </div>
  </div>
  <script>
    const userCodeParam = new URLSearchParams(window.location.search).get('user_code');
    const form = document.getElementById('form');
    const loading = document.getElementById('loading');
    const userCodeInput = document.getElementById('userCode');
    const errorDiv = document.getElementById('error');
    const successDiv = document.getElementById('success');

    // Show form after page load
    setTimeout(() => {
      loading.style.display = 'none';
      form.style.display = 'block';
      if (userCodeParam) {
        userCodeInput.value = userCodeParam.toUpperCase();
        userCodeInput.focus();
      } else {
        userCodeInput.focus();
      }
    }, 100);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = userCodeInput.value.trim().toUpperCase();
      errorDiv.style.display = 'none';
      
      try {
        const resp = await fetch('${baseUrl(req)}/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_code: code })
        });
        const data = await resp.json();
        if (!resp.ok) {
          throw new Error(data.error_description || data.error || 'Invalid code');
        }
        successDiv.style.display = 'block';
        form.style.display = 'none';
        setTimeout(() => window.close(), 2000);
      } catch (err) {
        errorDiv.textContent = err.message;
        errorDiv.style.display = 'block';
        userCodeInput.focus();
        userCodeInput.select();
      }
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...cors },
  });
}

async function handleVerifyCode(req: Request): Promise<Response> {
  const text = await req.text();
  let userCode: string | null = null;

  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const j = JSON.parse(text);
      userCode = (j.user_code as string)?.toUpperCase();
    } catch {
      return jsonResp({ error: "invalid_request", error_description: "Invalid JSON" }, 400);
    }
  } else {
    const b = new URLSearchParams(text);
    userCode = b.get("user_code")?.toUpperCase() ?? null;
  }

  if (!userCode) {
    return jsonResp({ error: "invalid_request", error_description: "user_code is required" }, 400);
  }

  const db = serviceClient();
  const { data: dc, error: dcErr } = await db.from("device_codes")
    .select("*")
    .eq("user_code", userCode)
    .single();

  if (dcErr || !dc) {
    return jsonResp({ error: "invalid_grant", error_description: "Invalid user code" }, 400);
  }

  if (dc.status !== "pending") {
    return jsonResp({ error: "invalid_grant", error_description: `Code is ${dc.status}` }, 400);
  }

  const expiresAt = new Date(dc.expires_at);
  if (expiresAt < new Date()) {
    await db.from("device_codes").update({ status: "expired" }).eq("id", dc.id);
    return jsonResp({ error: "expired_token", error_description: "Code has expired" }, 400);
  }

  // For now, auto-approve all codes. In production, you'd require user login here.
  // Generate a test access token that can be validated against Supabase
  const testUserId = Deno.env.get("TEST_USER_ID") || "00000000-0000-0000-0000-000000000000";
  const accessToken = await signJwt({ sub: testUserId, device_code: dc.device_code }, 3600);

  const { error: updateErr } = await db.from("device_codes")
    .update({ status: "approved", user_id: testUserId })
    .eq("id", dc.id);

  if (updateErr) {
    return jsonResp({ error: "server_error", error_description: updateErr.message }, 500);
  }

  return jsonResp({ success: true, message: "Device authorized" });
}

// Step 3: MCP client sends code_verifier → decrypt auth code → return access_token
// Also supports device_code grant for RFC 8628 Device Flow
async function handleToken(req: Request): Promise<Response> {
  const text = await req.text();
  // Accept both form-encoded and JSON bodies
  let grantType: string | null, code: string | null, codeVerifier: string | null, deviceCode: string | null;
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const j = JSON.parse(text);
      grantType = j.grant_type;
      code = j.code;
      codeVerifier = j.code_verifier;
      deviceCode = j.device_code;
    } catch {
      return jsonResp({ error: "invalid_request" }, 400);
    }
  } else {
    const b = new URLSearchParams(text);
    grantType = b.get("grant_type");
    code = b.get("code");
    codeVerifier = b.get("code_verifier");
    deviceCode = b.get("device_code");
  }

  if (grantType === "authorization_code") {
    if (!code || !codeVerifier) {
      return jsonResp({ error: "invalid_request", error_description: "Missing required params" }, 400);
    }
    const accessToken = await decryptWithVerifier(code, codeVerifier);
    if (!accessToken) {
      return jsonResp({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
    }
    return jsonResp({ access_token: accessToken, token_type: "bearer" });
  } else if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
    if (!deviceCode) {
      return jsonResp({ error: "invalid_request", error_description: "device_code is required" }, 400);
    }

    const db = serviceClient();
    const { data: dc, error: dcErr } = await db.from("device_codes")
      .select("*")
      .eq("device_code", deviceCode)
      .single();

    if (dcErr || !dc) {
      return jsonResp({ error: "invalid_grant", error_description: "Invalid device code" }, 400);
    }

    const expiresAt = new Date(dc.expires_at);
    if (expiresAt < new Date()) {
      await db.from("device_codes").update({ status: "expired" }).eq("id", dc.id);
      return jsonResp({ error: "expired_token", error_description: "Code has expired" }, 400);
    }

    if (dc.status === "pending") {
      return jsonResp({ error: "authorization_pending", error_description: "User has not yet authorized" }, 400);
    }

    if (dc.status === "denied") {
      return jsonResp({ error: "access_denied", error_description: "Authorization was denied" }, 400);
    }

    if (dc.status === "approved" && dc.user_id) {
      const accessToken = await signJwt({ sub: dc.user_id, device_code: deviceCode }, 3600);
      return jsonResp({ access_token: accessToken, token_type: "bearer", expires_in: 3600 });
    }

    return jsonResp({ error: "server_error", error_description: "Invalid device code state" }, 500);
  } else {
    return jsonResp(
      { error: "unsupported_grant_type", error_description: "Grant type not supported" },
      400,
    );
  }
}

// ---- MCP JSON-RPC ----

interface MCPReq { jsonrpc: string; id?: string | number; method: string; params?: Record<string, unknown> }
interface MCPResp { jsonrpc: string; id: string | number; result?: unknown; error?: { code: number; message: string } }

const mcpOk = (id: string | number, result: unknown): MCPResp => ({ jsonrpc: "2.0", id, result });
const mcpErr = (id: string | number, code: number, message: string): MCPResp => ({
  jsonrpc: "2.0", id, error: { code, message },
});

async function handleMCP(req: Request): Promise<Response> {
  if (req.method !== "POST") return jsonResp({ error: "Use POST" }, 405);
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
    return jsonResp({ error: "Content-Type must be application/json" }, 415);
  }

  let mcp: MCPReq;
  try { mcp = await req.json(); } catch { return jsonResp({ error: "Invalid JSON" }, 400); }
  if (mcp.jsonrpc !== "2.0" || !mcp.method) return jsonResp({ error: "Invalid JSON-RPC" }, 400);

  const reqId = mcp.id ?? Date.now();

  // Verify Bearer token using Supabase auth
  const authHeader = req.headers.get("authorization");
  let userId: string | null = null;

  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data.user) userId = data.user.id;
  }

  // For development/testing: allow a test user if no auth is provided and verify_jwt is false
  if (!userId) {
    // Use a stable test user ID for development
    const testUserId = Deno.env.get("TEST_USER_ID") || "00000000-0000-0000-0000-000000000000";
    userId = testUserId;
  }

  let resp: MCPResp;
  try {
    switch (mcp.method) {
      case "initialize":
        resp = mcpOk(reqId, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "todo-mcp-server", version: "1.0.0" },
        });
        break;
      case "tools/list":
        resp = mcpOk(reqId, { tools: TOOLS });
        break;
      case "tools/call":
        resp = await callTool(mcp, userId, reqId);
        break;
      default:
        resp = mcpErr(reqId, -32601, `Unknown method: ${mcp.method}`);
    }
  } catch (e) {
    resp = mcpErr(reqId, -32603, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (mcp.id == null) return new Response(null, { status: 204 });
  return jsonResp(resp);
}

function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function callTool(mcp: MCPReq, userId: string, reqId: string | number): Promise<MCPResp> {
  const { name, arguments: args = {} } = mcp.params as { name: string; arguments?: Record<string, unknown> };
  const db = serviceClient();

  switch (name) {
    case "list_todos": {
      const { data, error } = await db.from("todos")
        .select("id, title, completed, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      if (!data?.length) return mcpOk(reqId, { content: [{ type: "text", text: "No todos found." }] });
      const text = data.map((t: { completed: boolean; title: string }, i: number) =>
        `${i + 1}. ${t.completed ? "✅" : "⏳"} ${t.title}`).join("\n");
      return mcpOk(reqId, { content: [{ type: "text", text }] });
    }
    case "create_todo": {
      const title = (args.title as string)?.trim();
      if (!title) return mcpErr(reqId, -32602, "title is required");
      const { data, error } = await db.from("todos")
        .insert({ title, completed: args.completed ?? false, user_id: userId })
        .select("id, title").single();
      if (error) throw new Error(error.message);
      return mcpOk(reqId, { content: [{ type: "text", text: `Created: "${data.title}" (ID: ${data.id})` }] });
    }
    case "update_todo": {
      const id = args.id as string;
      if (!id) return mcpErr(reqId, -32602, "id is required");
      const update: Record<string, unknown> = {};
      if (args.title !== undefined) update.title = (args.title as string).trim();
      if (args.completed !== undefined) update.completed = args.completed;
      const { data, error } = await db.from("todos")
        .update(update).eq("id", id).eq("user_id", userId)
        .select("title, completed").single();
      if (error) throw new Error(error.message);
      return mcpOk(reqId, { content: [{ type: "text", text: `Updated: ${data.completed ? "✅" : "⏳"} ${data.title}` }] });
    }
    case "delete_todo": {
      const id = args.id as string;
      if (!id) return mcpErr(reqId, -32602, "id is required");
      const { error } = await db.from("todos").delete().eq("id", id).eq("user_id", userId);
      if (error) throw new Error(error.message);
      return mcpOk(reqId, { content: [{ type: "text", text: `Deleted todo ID: ${id}` }] });
    }
    default:
      return mcpErr(reqId, -32601, `Unknown tool: ${name}`);
  }
}

const TOOLS = [
  {
    name: "list_todos",
    description: "List all todos",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_todo",
    description: "Create a new todo",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        completed: { type: "boolean" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_todo",
    description: "Update a todo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        completed: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_todo",
    description: "Delete a todo",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
];

// ---- Router ----

function baseUrl(req: Request): string {
  const u = new URL(req.url);
  return `https://${u.host}${PUBLIC_FUNCTION_PATH}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const sub = new URL(req.url).pathname.slice(FUNCTION_PATH.length) || "/";

  if (sub === "/.well-known/oauth-protected-resource" && req.method === "GET") return handleResourceMetadata(req);
  if (sub === "/.well-known/oauth-authorization-server" && req.method === "GET") return handleAuthServerMetadata(req);
  if (sub === "/.well-known/openid-configuration" && req.method === "GET") return handleOidcMetadata(req);
  if (sub === "/register" && req.method === "POST") return handleRegister(req);
  if (sub === "/authorize" && req.method === "GET") return handleAuthorize(req);
  if (sub === "/callback" && req.method === "GET") return handleCallback(req);
  if (sub === "/token" && req.method === "POST") return handleToken(req);

  // Device Flow (RFC 8628)
  if (sub === "/device" && req.method === "POST") return handleDeviceRequest(req);
  if (sub === "/verify" && req.method === "GET") return handleVerifyPage(req);
  if (sub === "/verify" && req.method === "POST") return handleVerifyCode(req);

  return handleMCP(req);
});
