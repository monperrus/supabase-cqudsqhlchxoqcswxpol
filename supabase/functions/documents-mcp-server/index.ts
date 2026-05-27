import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const FUNCTION_PATH = "/documents-mcp-server";
const PUBLIC_FUNCTION_PATH = "/functions/v1/documents-mcp-server";

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
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToB64url(new Uint8Array(sig));
}

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
      { name: "AES-GCM", iv: combined.slice(0, 12) },
      key,
      combined.slice(12),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

function baseUrl(req: Request): string {
  const u = new URL(req.url);
  return `https://${u.host}${PUBLIC_FUNCTION_PATH}`;
}

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

function handleOidcMetadata(req: Request) {
  const base = baseUrl(req);
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  return jsonResp({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
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
  try {
    meta = await req.json();
  } catch {
    // Empty dynamic client registration body is acceptable.
  }
  return jsonResp({
    client_id: randomB64url(16),
    client_secret_expires_at: 0,
    redirect_uris: meta.redirect_uris ?? [],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

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

  const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseCodeVerifier = await hmacB64url(codeChallenge, secret);
  const supabaseCodeChallenge = await sha256b64url(supabaseCodeVerifier);

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

async function handleCallback(req: Request): Promise<Response> {
  const p = new URL(req.url).searchParams;
  const authId = p.get("auth_id");
  const supabaseCode = p.get("code");

  if (!authId || !supabaseCode) {
    return new Response("<h1>Error</h1><p>Missing auth_id or code parameter.</p>", {
      status: 400,
      headers: { "Content-Type": "text/html" },
    });
  }

  const db = serviceClient();
  const { data: row, error: rowErr } = await db.from("mcp_auth_codes")
    .select("*")
    .eq("id", authId)
    .is("used_at", null)
    .single();

  if (rowErr || !row || new Date(row.expires_at) < new Date()) {
    return new Response("<h1>Error</h1><p>Invalid or expired OAuth session. Please try again.</p>", {
      status: 400,
      headers: { "Content-Type": "text/html" },
    });
  }

  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const tokenRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": anonKey,
      "Authorization": `Bearer ${anonKey}`,
    },
    body: JSON.stringify({ auth_code: supabaseCode, code_verifier: row.supabase_code_verifier }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return new Response(`<h1>Auth Error</h1><pre>${htmlEscape(err)}</pre>`, {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
  }

  const { access_token } = await tokenRes.json();
  if (!access_token) {
    return new Response("<h1>Error</h1><p>No access token returned.</p>", {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
  }

  const authCode = await encryptWithChallenge(access_token, row.mcp_code_challenge as string);
  await db.from("mcp_auth_codes").update({ used_at: new Date().toISOString() }).eq("id", authId);

  const dest = new URL(row.mcp_redirect_uri as string);
  dest.searchParams.set("code", authCode);
  if (row.mcp_state) dest.searchParams.set("state", row.mcp_state as string);

  return redirect(dest.toString());
}

async function handleToken(req: Request): Promise<Response> {
  const text = await req.text();
  let grantType: string | null;
  let code: string | null;
  let codeVerifier: string | null;

  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const j = JSON.parse(text);
      grantType = j.grant_type;
      code = j.code;
      codeVerifier = j.code_verifier;
    } catch {
      return jsonResp({ error: "invalid_request" }, 400);
    }
  } else {
    const b = new URLSearchParams(text);
    grantType = b.get("grant_type");
    code = b.get("code");
    codeVerifier = b.get("code_verifier");
  }

  if (grantType !== "authorization_code") {
    return jsonResp({ error: "unsupported_grant_type", error_description: "Grant type not supported" }, 400);
  }
  if (!code || !codeVerifier) {
    return jsonResp({ error: "invalid_request", error_description: "Missing required params" }, 400);
  }

  const accessToken = await decryptWithVerifier(code, codeVerifier);
  if (!accessToken) {
    return jsonResp({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
  }
  return jsonResp({ access_token: accessToken, token_type: "bearer" });
}

type OAuthUser = { id: string; username: string; oauthOrigin: string };
type OAuthUserResult = { ok: true; user: OAuthUser } | { ok: false; message: string };

function recordFrom(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringFrom(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstStringFrom(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringFrom(record, key);
    if (value) return value;
  }
  return null;
}

function oauthOriginFromSupabaseUser(user: Record<string, unknown>): string {
  const appMetadata = recordFrom(user.app_metadata);
  const provider = stringFrom(appMetadata, "provider");
  if (provider) return provider;

  const providers = appMetadata.providers;
  if (Array.isArray(providers)) {
    const firstProvider = providers.find((value) => typeof value === "string" && value.trim());
    if (typeof firstProvider === "string") return firstProvider.trim();
  }

  const identities = user.identities;
  if (Array.isArray(identities)) {
    for (const identity of identities) {
      const identityProvider = stringFrom(recordFrom(identity), "provider");
      if (identityProvider) return identityProvider;
    }
  }

  return "unknown";
}

function oauthUserFromSupabaseUser(user: Record<string, unknown>): OAuthUser {
  const metadata = recordFrom(user.user_metadata);
  const email = stringFrom(user, "email");
  const username = firstStringFrom(metadata, [
    "user_name",
    "preferred_username",
    "username",
    "name",
    "full_name",
  ]) ?? email ?? stringFrom(user, "id") ?? "unknown";

  return {
    id: stringFrom(user, "id") ?? "unknown",
    username,
    oauthOrigin: oauthOriginFromSupabaseUser(user),
  };
}

function quoteHeaderValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function oauthUnauthorized(req: Request, message: string): Response {
  const resourceMetadata = `${baseUrl(req)}/.well-known/oauth-protected-resource`;
  return jsonResp({ error: "unauthorized", error_description: message }, 401, {
    "WWW-Authenticate": `Bearer realm="documents-mcp-server", resource_metadata="${
      quoteHeaderValue(resourceMetadata)
    }"`,
  });
}

async function getOAuthUser(req: Request): Promise<OAuthUserResult> {
  const authHeader = req.headers.get("authorization");
  const match = authHeader?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token) {
    return { ok: false, message: "OAuth bearer token required" };
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data.user) {
      return { ok: true, user: oauthUserFromSupabaseUser(data.user as unknown as Record<string, unknown>) };
    }
  } catch {
    // Treat auth service failures the same as invalid bearer tokens.
  }

  return { ok: false, message: "Invalid or expired OAuth bearer token" };
}

interface MCPReq {
  jsonrpc: string;
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}
interface MCPResp {
  jsonrpc: string;
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

const mcpOk = (id: string | number, result: unknown): MCPResp => ({ jsonrpc: "2.0", id, result });
const mcpErr = (id: string | number, code: number, message: string): MCPResp => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

async function handleMCP(req: Request): Promise<Response> {
  if (req.method !== "POST") return jsonResp({ error: "Use POST" }, 405);

  const auth = await getOAuthUser(req);
  if (!auth.ok) return oauthUnauthorized(req, auth.message);

  if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
    return jsonResp({ error: "Content-Type must be application/json" }, 415);
  }

  let mcp: MCPReq;
  try {
    mcp = await req.json();
  } catch {
    return jsonResp({ error: "Invalid JSON" }, 400);
  }
  if (mcp.jsonrpc !== "2.0" || !mcp.method) return jsonResp({ error: "Invalid JSON-RPC" }, 400);

  const reqId = mcp.id ?? Date.now();
  let resp: MCPResp;
  try {
    switch (mcp.method) {
      case "initialize":
        resp = mcpOk(reqId, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "documents-mcp-server", version: "1.0.0" },
        });
        break;
      case "tools/list":
        resp = mcpOk(reqId, { tools: TOOLS });
        break;
      case "tools/call":
        resp = await callTool(mcp, auth.user, reqId);
        break;
      case "add_markdown_doc":
      case "update_markdown_doc":
      case "search_markdown_doc":
      case "whoami":
        resp = await callNamedTool(mcp.method, mcp.params ?? {}, auth.user, reqId);
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

function htmlEscape(str: string): string {
  return str.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function requiredString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function callTool(mcp: MCPReq, user: OAuthUser, reqId: string | number): Promise<MCPResp> {
  const { name, arguments: args = {} } = mcp.params as { name: string; arguments?: Record<string, unknown> };
  return callNamedTool(name, args, user, reqId);
}

async function callNamedTool(
  name: string,
  args: Record<string, unknown>,
  user: OAuthUser,
  reqId: string | number,
): Promise<MCPResp> {
  const db = serviceClient();

  switch (name) {
    case "whoami":
      return mcpOk(reqId, {
        content: [{
          type: "text",
          text: `Connected as ${user.username} via ${user.oauthOrigin}.`,
        }],
      });
    case "add_markdown_doc": {
      const title = requiredString(args, "title");
      const content = requiredString(args, "content");
      if (!title) return mcpErr(reqId, -32602, "title is required");
      if (!content) return mcpErr(reqId, -32602, "content is required");

      const { data, error } = await db.from("markdown_documents")
        .insert({ title, content, user_id: user.id })
        .select("id, title")
        .single();
      if (error) throw new Error(error.message);
      return mcpOk(reqId, { content: [{ type: "text", text: `Added document "${data.title}" (ID: ${data.id})` }] });
    }
    case "update_markdown_doc": {
      const id = args.id;
      if (typeof id !== "number" && typeof id !== "string") return mcpErr(reqId, -32602, "id is required");

      const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
      const title = requiredString(args, "title");
      const content = requiredString(args, "content");
      if (title) update.title = title;
      if (content) update.content = content;
      if (!title && !content) return mcpErr(reqId, -32602, "title or content is required");

      const { data, error } = await db.from("markdown_documents")
        .update(update)
        .eq("id", id)
        .eq("user_id", user.id)
        .select("id, title")
        .single();
      if (error) throw new Error(error.message);
      return mcpOk(reqId, { content: [{ type: "text", text: `Updated document "${data.title}" (ID: ${data.id})` }] });
    }
    case "search_markdown_doc": {
      const query = requiredString(args, "query");
      if (!query) return mcpErr(reqId, -32602, "query is required");

      const titleResult = await db.from("markdown_documents")
        .select("id, title, content, updated_at")
        .eq("user_id", user.id)
        .ilike("title", `%${query}%`)
        .order("updated_at", { ascending: false })
        .limit(10);
      if (titleResult.error) throw new Error(titleResult.error.message);

      const contentResult = await db.from("markdown_documents")
        .select("id, title, content, updated_at")
        .eq("user_id", user.id)
        .ilike("content", `%${query}%`)
        .order("updated_at", { ascending: false })
        .limit(10);
      if (contentResult.error) throw new Error(contentResult.error.message);

      const byId = new Map<number, { id: number; title: string; content: string; updated_at: string }>();
      for (const doc of titleResult.data ?? []) byId.set(doc.id, doc);
      for (const doc of contentResult.data ?? []) byId.set(doc.id, doc);
      const data = [...byId.values()]
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 10);

      if (!data.length) return mcpOk(reqId, { content: [{ type: "text", text: "No matching documents found." }] });

      const text = data.map((doc: { id: number; title: string; content: string }) => {
        const snippet = doc.content.replace(/\s+/g, " ").slice(0, 180);
        return `- ${doc.title} (ID: ${doc.id}): ${snippet}`;
      }).join("\n");
      return mcpOk(reqId, { content: [{ type: "text", text }] });
    }
    default:
      return mcpErr(reqId, -32601, `Unknown tool: ${name}`);
  }
}

const TOOLS = [
  {
    name: "add_markdown_doc",
    description: "Add a Markdown document",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "update_markdown_doc",
    description: "Update a Markdown document",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: ["integer", "string"] },
        title: { type: "string" },
        content: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "search_markdown_doc",
    description: "Search Markdown documents",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "whoami",
    description: "Show the connected OAuth user",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

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

  return handleMCP(req);
});
