import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Supabase strips /functions/v1 from req.url internally; externally the path is /functions/v1/todo-mcp-server
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

async function sha256b64url(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function randomB64url(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
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

// Dynamic client registration — accept any public client
async function handleRegister(req: Request) {
  let meta: Record<string, unknown> = {};
  try { meta = await req.json(); } catch { /* no body */ }
  return jsonResp({
    client_id: randomB64url(16),
    client_secret_expires_at: 0,
    redirect_uris: meta.redirect_uris ?? [],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

// Step 1: MCP client → our /authorize → redirect to GitHub via Supabase PKCE
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

  const supabaseCodeVerifier = randomB64url(32);
  const supabaseCodeChallenge = await sha256b64url(supabaseCodeVerifier);

  const db = serviceClient();
  const { data, error } = await db.from("mcp_auth_codes").insert({
    mcp_code_challenge: codeChallenge,
    mcp_code_challenge_method: codeChallengeMethod,
    mcp_redirect_uri: redirectUri,
    mcp_client_id: clientId,
    mcp_state: state,
    supabase_code_verifier: supabaseCodeVerifier,
  }).select("id").single();

  if (error || !data) {
    return jsonResp({ error: "server_error", error_description: "DB insert failed" }, 500);
  }

  const callbackUrl = `${baseUrl(req)}/callback?session_id=${data.id}`;
  const authUrl = new URL(`${Deno.env.get("SUPABASE_URL")}/auth/v1/authorize`);
  authUrl.searchParams.set("provider", "github");
  authUrl.searchParams.set("redirect_to", callbackUrl);
  authUrl.searchParams.set("code_challenge", supabaseCodeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return redirect(authUrl.toString());
}

// Step 2: Supabase redirects here after GitHub OAuth; exchange code → token; redirect to MCP client
async function handleCallback(req: Request): Promise<Response> {
  const p = new URL(req.url).searchParams;
  const sessionId = p.get("session_id");
  const code = p.get("code"); // Supabase PKCE auth code

  if (!sessionId || !code) {
    return jsonResp({ error: "invalid_request", error_description: "Missing session_id or code" }, 400);
  }

  const db = serviceClient();
  const { data: session, error: lookupErr } = await db.from("mcp_auth_codes")
    .select("*")
    .eq("id", sessionId)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .single();

  if (lookupErr || !session) {
    return jsonResp({ error: "invalid_request", error_description: "Invalid or expired session" }, 400);
  }

  // Exchange Supabase auth code for access_token using PKCE
  const tokenRes = await fetch(
    `${Deno.env.get("SUPABASE_URL")}/auth/v1/token?grant_type=pkce`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": Deno.env.get("SUPABASE_ANON_KEY")!,
      },
      body: JSON.stringify({
        auth_code: code,
        code_verifier: session.supabase_code_verifier,
      }),
    },
  );

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return jsonResp({ error: "server_error", error_description: `Supabase token exchange failed: ${err}` }, 500);
  }

  const { access_token } = await tokenRes.json();
  if (!access_token) {
    return jsonResp({ error: "server_error", error_description: "No access_token in Supabase response" }, 500);
  }

  await db.from("mcp_auth_codes").update({ supabase_access_token: access_token }).eq("id", sessionId);

  // Redirect MCP client back with our auth code (= sessionId)
  const dest = new URL(session.mcp_redirect_uri);
  dest.searchParams.set("code", sessionId);
  if (session.mcp_state) dest.searchParams.set("state", session.mcp_state);

  return redirect(dest.toString());
}

// Step 3: MCP client exchanges our auth code for the Supabase access_token
async function handleToken(req: Request): Promise<Response> {
  const text = await req.text();
  const body = new URLSearchParams(text);

  const grantType = body.get("grant_type");
  const code = body.get("code");
  const codeVerifier = body.get("code_verifier");

  if (grantType !== "authorization_code" || !code || !codeVerifier) {
    return jsonResp({ error: "invalid_request", error_description: "Missing required params" }, 400);
  }

  const db = serviceClient();
  const { data: session, error } = await db.from("mcp_auth_codes")
    .select("*")
    .eq("id", code)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .not("supabase_access_token", "is", null)
    .single();

  if (error || !session) {
    return jsonResp({ error: "invalid_grant", error_description: "Invalid or expired code" }, 400);
  }

  // Verify PKCE
  const computed = await sha256b64url(codeVerifier);
  if (computed !== session.mcp_code_challenge) {
    return jsonResp({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
  }

  await db.from("mcp_auth_codes").update({ used_at: new Date().toISOString() }).eq("id", code);

  return jsonResp({ access_token: session.supabase_access_token, token_type: "bearer" });
}

// ---- MCP JSON-RPC ----

interface MCPReq { jsonrpc: string; id?: string | number; method: string; params?: Record<string, unknown> }
interface MCPResp { jsonrpc: string; id: string | number; result?: unknown; error?: { code: number; message: string } }

function mcpOk(id: string | number, result: unknown): MCPResp {
  return { jsonrpc: "2.0", id, result };
}
function mcpErr(id: string | number, code: number, message: string): MCPResp {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMCP(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  if (req.method !== "POST") return jsonResp({ error: "Use POST" }, 405);
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
    return jsonResp({ error: "Content-Type must be application/json" }, 415);
  }

  let mcp: MCPReq;
  try { mcp = await req.json(); } catch { return jsonResp({ error: "Invalid JSON" }, 400); }

  if (mcp.jsonrpc !== "2.0" || !mcp.method) return jsonResp({ error: "Invalid JSON-RPC" }, 400);

  const reqId = mcp.id ?? Date.now();

  // Verify auth for all requests
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
    const wwwAuth = `Bearer resource_metadata="${resourceMeta}"`;
    if (mcp.id == null) return new Response(null, { status: 204 });
    return jsonResp(mcpErr(reqId, -32600, "Authorization required"), 401, {
      "WWW-Authenticate": wwwAuth,
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
      const text = data.map((t: any, i: number) => `${i + 1}. ${t.completed ? "✅" : "⏳"} ${t.title}`).join("\n");
      return mcpOk(reqId, { content: [{ type: "text", text }] });
    }

    case "create_todo": {
      const title = (args.title as string)?.trim();
      if (!title) return mcpErr(reqId, -32602, "title is required");
      const { data, error } = await db.from("todos")
        .insert({ title, completed: args.completed ?? false, user_id: userId })
        .select("id, title, completed, created_at").single();
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
        .select("id, title, completed").single();
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
    description: "List all todos from the database",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_todo",
    description: "Create a new todo",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The title of the todo" },
        completed: { type: "boolean", description: "Whether completed (default: false)" },
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
        id: { type: "string", description: "The ID of the todo to update" },
        title: { type: "string", description: "New title (optional)" },
        completed: { type: "boolean", description: "New completed status (optional)" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_todo",
    description: "Delete a todo",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The ID of the todo to delete" } },
      required: ["id"],
    },
  },
];

// ---- Router ----

function baseUrl(req: Request): string {
  const u = new URL(req.url);
  // Always return public https URL with full path
  return `https://${u.host}${PUBLIC_FUNCTION_PATH}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const u = new URL(req.url);
  const sub = u.pathname.slice(FUNCTION_PATH.length) || "/";


  if (sub === "/.well-known/oauth-protected-resource" && req.method === "GET") return handleResourceMetadata(req);
  if (sub === "/.well-known/oauth-authorization-server" && req.method === "GET") return handleAuthServerMetadata(req);
  if (sub === "/register" && req.method === "POST") return handleRegister(req);
  if (sub === "/authorize" && req.method === "GET") return handleAuthorize(req);
  if (sub === "/callback" && req.method === "GET") return handleCallback(req);
  if (sub === "/token" && req.method === "POST") return handleToken(req);

  return handleMCP(req);
});
