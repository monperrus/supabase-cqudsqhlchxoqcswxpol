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

// Lightweight signed JWT (HS256) for passing OAuth state through redirects
async function signJwt(payload: Record<string, unknown>, ttl = 600): Promise<string> {
  const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const now = Math.floor(Date.now() / 1000);
  const h = textToB64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = textToB64url(JSON.stringify({ ...payload, iat: now, exp: now + ttl }));
  const sig = await hmacB64url(`${h}.${p}`, secret);
  return `${h}.${p}.${sig}`;
}

async function verifyJwt(token: string): Promise<Record<string, unknown> | null> {
  const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expected = await hmacB64url(`${parts[0]}.${parts[1]}`, secret);
  if (expected !== parts[2]) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    if (payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch { return null; }
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

// Step 1: MCP client → /authorize → signs state JWT, starts Supabase GitHub OAuth
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
  // This avoids storing anything in the DB.
  const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseCodeVerifier = await hmacB64url(codeChallenge, secret);
  const supabaseCodeChallenge = await sha256b64url(supabaseCodeVerifier);

  // Encode all MCP params in a signed JWT passed through the OAuth state
  const stateJwt = await signJwt({
    code_challenge: codeChallenge,
    mcp_redirect_uri: redirectUri,
    mcp_state: state,
    mcp_client_id: clientId,
  });

  const callbackUrl = `${baseUrl(req)}/callback`;
  const authUrl = new URL(`${Deno.env.get("SUPABASE_URL")}/auth/v1/authorize`);
  authUrl.searchParams.set("provider", "github");
  authUrl.searchParams.set("redirect_to", `${callbackUrl}?s=${encodeURIComponent(stateJwt)}`);
  authUrl.searchParams.set("code_challenge", supabaseCodeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return redirect(authUrl.toString());
}

// Step 2: Supabase redirects here → exchange Supabase code → encrypt token → redirect to MCP client
async function handleCallback(req: Request): Promise<Response> {
  const p = new URL(req.url).searchParams;
  const stateJwt = p.get("s");
  const supabaseCode = p.get("code");

  if (!stateJwt || !supabaseCode) {
    return new Response("<h1>Error</h1><p>Missing state or code parameter.</p>", {
      status: 400, headers: { "Content-Type": "text/html" },
    });
  }

  const st = await verifyJwt(stateJwt);
  if (!st) {
    return new Response("<h1>Error</h1><p>Invalid or expired OAuth session. Please try again.</p>", {
      status: 400, headers: { "Content-Type": "text/html" },
    });
  }

  const codeChallenge = st.code_challenge as string;
  const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseCodeVerifier = await hmacB64url(codeChallenge, secret);

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
      body: JSON.stringify({ auth_code: supabaseCode, code_verifier: supabaseCodeVerifier }),
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
  const authCode = await encryptWithChallenge(access_token, codeChallenge);

  const dest = new URL(st.mcp_redirect_uri as string);
  dest.searchParams.set("code", authCode);
  if (st.mcp_state) dest.searchParams.set("state", st.mcp_state as string);

  return redirect(dest.toString());
}

// Step 3: MCP client sends code_verifier → decrypt auth code → return access_token
async function handleToken(req: Request): Promise<Response> {
  const text = await req.text();
  // Accept both form-encoded and JSON bodies
  let grantType: string | null, code: string | null, codeVerifier: string | null;
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const j = JSON.parse(text);
      grantType = j.grant_type; code = j.code; codeVerifier = j.code_verifier;
    } catch { return jsonResp({ error: "invalid_request" }, 400); }
  } else {
    const b = new URLSearchParams(text);
    grantType = b.get("grant_type"); code = b.get("code"); codeVerifier = b.get("code_verifier");
  }

  if (grantType !== "authorization_code" || !code || !codeVerifier) {
    return jsonResp({ error: "invalid_request", error_description: "Missing required params" }, 400);
  }

  const accessToken = await decryptWithVerifier(code, codeVerifier);
  if (!accessToken) {
    return jsonResp({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
  }

  return jsonResp({ access_token: accessToken, token_type: "bearer" });
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

  if (!userId) {
    const resourceMeta = `${baseUrl(req)}/.well-known/oauth-protected-resource`;
    if (mcp.id == null) return new Response(null, { status: 204 });
    return jsonResp(mcpErr(reqId, -32600, "Authorization required"), 401, {
      "WWW-Authenticate": `Bearer resource_metadata="${resourceMeta}"`,
    });
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
  if (sub === "/register" && req.method === "POST") return handleRegister(req);
  if (sub === "/authorize" && req.method === "GET") return handleAuthorize(req);
  if (sub === "/callback" && req.method === "GET") return handleCallback(req);
  if (sub === "/token" && req.method === "POST") return handleToken(req);

  return handleMCP(req);
});
