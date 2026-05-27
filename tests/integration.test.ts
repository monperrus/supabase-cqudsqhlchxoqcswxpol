/**
 * Integration tests against the live Supabase deployment.
 *
 * Run with:
 *   deno test --allow-net --allow-env tests/integration.test.ts
 *
 * Tests that write to the database require a real auth.users entry.
 * Set SUPABASE_TEST_USER_ID to a valid UUID from auth.users to enable them.
 * In CI this is done automatically by the deploy workflow.
 *
 * create-todo / list-todos / update-todo decode JWT without signature
 * verification, so we pass a structurally-valid fake token built around the
 * test user ID.
 *
 * todo-mcp-server requires an OAuth bearer token. Set SUPABASE_MCP_ACCESS_TOKEN
 * to run authenticated MCP tests against the live deployment.
 */

import { assertEquals, assertExists } from "jsr:@std/assert";

const BASE = "https://cqudsqhlchxoqcswxpol.supabase.co/functions/v1";

// Set by CI after creating / locating the integration-test auth user.
// When absent, any test that inserts into the DB is skipped.
const TEST_USER = Deno.env.get("SUPABASE_TEST_USER_ID") ?? "";
const HAS_USER = TEST_USER.length > 0;
const MCP_ACCESS_TOKEN = Deno.env.get("SUPABASE_MCP_ACCESS_TOKEN") ?? "";
const HAS_MCP_AUTH = MCP_ACCESS_TOKEN.length > 0;

/** Build a structurally-valid JWT the functions can base64-decode. */
function fakeJwt(userId: string): string {
  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  const h = b64url({ alg: "HS256", typ: "JWT" });
  const p = b64url({ sub: userId, iat: Math.floor(Date.now() / 1000) });
  return `${h}.${p}.sig`;
}

// AUTH_HDR is used for happy-path tests (real user, skipped when absent).
const AUTH_HDR = HAS_USER ? `Bearer ${fakeJwt(TEST_USER)}` : "";
// ANON_HDR uses an all-zeros UUID — passes JWT format check but has no real
// user, so only safe for error-validation tests that never reach the DB.
const ANON_HDR = `Bearer ${fakeJwt("00000000-0000-0000-0000-000000000000")}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mcpBody(method: string, params?: Record<string, unknown>, authorization = ""): RequestInit {
  const body: Record<string, unknown> = { jsonrpc: "2.0", id: 1, method };
  if (params !== undefined) body.params = params;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authorization) headers.Authorization = authorization;
  return {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// create-todo
// ---------------------------------------------------------------------------

Deno.test({
  name: "create-todo POST: valid title → 201 with todo object",
  ignore: !HAS_USER,
  fn: async () => {
    const res = await fetch(`${BASE}/create-todo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: AUTH_HDR },
      body: JSON.stringify({ title: "Integration Test Todo" }),
    });
    assertEquals(res.status, 201);
    const { todo } = await res.json();
    assertExists(todo.id);
    assertEquals(todo.title, "Integration Test Todo");
    assertEquals(todo.completed, false);
  },
});

Deno.test("create-todo POST: no auth → 401", async () => {
  const res = await fetch(`${BASE}/create-todo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Test" }),
  });
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("create-todo POST: blank title → 400", async () => {
  const res = await fetch(`${BASE}/create-todo`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: AUTH_HDR || ANON_HDR },
    body: JSON.stringify({ title: "   " }),
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("create-todo POST: completed not boolean → 400", async () => {
  const res = await fetch(`${BASE}/create-todo`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: AUTH_HDR || ANON_HDR },
    body: JSON.stringify({ title: "Test", completed: "yes" }),
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("create-todo GET → 405", async () => {
  const res = await fetch(`${BASE}/create-todo`);
  assertEquals(res.status, 405);
  await res.body?.cancel();
});

// ---------------------------------------------------------------------------
// list-todos
// ---------------------------------------------------------------------------

Deno.test({
  name: "list-todos GET: with auth → 200 with todos array",
  ignore: !HAS_USER,
  fn: async () => {
    const res = await fetch(`${BASE}/list-todos`, {
      headers: { Authorization: AUTH_HDR },
    });
    assertEquals(res.status, 200);
    const { todos } = await res.json();
    assertEquals(Array.isArray(todos), true);
  },
});

Deno.test("list-todos GET: no auth → 401", async () => {
  const res = await fetch(`${BASE}/list-todos`);
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("list-todos POST → 405", async () => {
  const res = await fetch(`${BASE}/list-todos`, { method: "POST" });
  assertEquals(res.status, 405);
  await res.body?.cancel();
});

// ---------------------------------------------------------------------------
// update-todo
// ---------------------------------------------------------------------------

Deno.test({
  name: "update-todo PATCH: toggle completed → 200 with updated todo",
  ignore: !HAS_USER,
  fn: async () => {
    // Create a todo to update
    const createRes = await fetch(`${BASE}/create-todo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: AUTH_HDR },
      body: JSON.stringify({ title: "Todo to Update" }),
    });
    assertEquals(createRes.status, 201);
    const { todo } = await createRes.json();

    const res = await fetch(`${BASE}/update-todo`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: AUTH_HDR },
      body: JSON.stringify({ id: String(todo.id), completed: true }),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.todo.completed, true);
    assertEquals(body.todo.title, "Todo to Update");
  },
});

Deno.test("update-todo PATCH: no auth → 401", async () => {
  const res = await fetch(`${BASE}/update-todo`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "1", completed: true }),
  });
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("update-todo PATCH: missing id → 400", async () => {
  const res = await fetch(`${BASE}/update-todo`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH_HDR || ANON_HDR,
    },
    body: JSON.stringify({ completed: true }),
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("update-todo PATCH: no update fields → 400", async () => {
  const res = await fetch(`${BASE}/update-todo`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH_HDR || ANON_HDR,
    },
    body: JSON.stringify({ id: "1" }),
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("update-todo GET → 405", async () => {
  const res = await fetch(`${BASE}/update-todo`);
  assertEquals(res.status, 405);
  await res.body?.cancel();
});

// ---------------------------------------------------------------------------
// todo-mcp-server (MCP JSON-RPC)
// ---------------------------------------------------------------------------

const MCP = `${BASE}/todo-mcp-server`;
const MCP_AUTH_HDR = HAS_MCP_AUTH ? `Bearer ${MCP_ACCESS_TOKEN}` : "";

Deno.test("todo-mcp-server: no auth returns 401", async () => {
  const res = await fetch(MCP, mcpBody("initialize"));
  assertEquals(res.status, 401);
  assertEquals(res.headers.get("www-authenticate")?.includes("resource_metadata"), true);
  await res.body?.cancel();
});

Deno.test("todo-mcp-server: invalid bearer token returns 401", async () => {
  const res = await fetch(MCP, mcpBody("initialize", undefined, "Bearer invalid-token"));
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("todo-mcp-server: missing content type with no auth still returns 401", async () => {
  const res = await fetch(MCP, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test({
  name: "todo-mcp-server: initialize returns protocol version",
  ignore: !HAS_MCP_AUTH,
  fn: async () => {
    const res = await fetch(MCP, mcpBody("initialize", undefined, MCP_AUTH_HDR));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.result.protocolVersion, "2024-11-05");
    assertEquals(body.result.serverInfo.name, "todo-mcp-server");
  },
});

Deno.test({
  name: "todo-mcp-server: tools/list returns the 5 expected tools",
  ignore: !HAS_MCP_AUTH,
  fn: async () => {
    const res = await fetch(MCP, mcpBody("tools/list", undefined, MCP_AUTH_HDR));
    assertEquals(res.status, 200);
    const body = await res.json();
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name).sort();
    assertEquals(names, ["create_todo", "delete_todo", "list_todos", "update_todo", "whoami"]);
  },
});

Deno.test({
  name: "todo-mcp-server: user/info returns OAuth user details",
  ignore: !HAS_MCP_AUTH,
  fn: async () => {
    const res = await fetch(MCP, mcpBody("user/info", undefined, MCP_AUTH_HDR));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(typeof body.result.user.id, "string");
    assertEquals(typeof body.result.user.username, "string");
    assertEquals(typeof body.result.user.oauth_origin, "string");
  },
});

Deno.test({
  name: "todo-mcp-server: whoami returns connected OAuth user text",
  ignore: !HAS_MCP_AUTH,
  fn: async () => {
    const res = await fetch(MCP, mcpBody("tools/call", { name: "whoami", arguments: {} }, MCP_AUTH_HDR));
    assertEquals(res.status, 200);
    const body = await res.json();
    const text = body.result.content[0].text as string;
    assertEquals(text.includes("Connected as "), true);
    assertEquals(text.includes(" via "), true);
  },
});

Deno.test({
  name: "todo-mcp-server: list_todos returns content array",
  ignore: !HAS_MCP_AUTH,
  fn: async () => {
    const res = await fetch(MCP, mcpBody("tools/call", { name: "list_todos", arguments: {} }, MCP_AUTH_HDR));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body.result.content);
    assertEquals(Array.isArray(body.result.content), true);
  },
});

Deno.test({
  name: "todo-mcp-server: create_todo then delete_todo round-trip",
  ignore: !HAS_MCP_AUTH,
  fn: async () => {
    // Create
    const createRes = await fetch(
      MCP,
      mcpBody("tools/call", { name: "create_todo", arguments: { title: "MCP Integration Test" } }, MCP_AUTH_HDR),
    );
    assertEquals(createRes.status, 200);
    const createBody = await createRes.json();
    assertExists(createBody.result, `Expected result, got: ${JSON.stringify(createBody)}`);
    const text: string = createBody.result.content[0].text;
    const match = text.match(/\(ID: (\d+)\)/);
    assertExists(match, `Expected ID in response text, got: "${text}"`);
    const id = match[1];

    // Delete
    const deleteRes = await fetch(
      MCP,
      mcpBody("tools/call", { name: "delete_todo", arguments: { id } }, MCP_AUTH_HDR),
    );
    assertEquals(deleteRes.status, 200);
    const deleteBody = await deleteRes.json();
    assertEquals(deleteBody.result.content[0].text, `Deleted todo ID: ${id}`);
  },
});

Deno.test({
  name: "todo-mcp-server: unknown method returns JSON-RPC error -32601",
  ignore: !HAS_MCP_AUTH,
  fn: async () => {
    const res = await fetch(MCP, mcpBody("unknown/method", undefined, MCP_AUTH_HDR));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body.error);
    assertEquals(body.error.code, -32601);
  },
});

Deno.test({
  name: "todo-mcp-server: create_todo without title returns JSON-RPC error -32602",
  ignore: !HAS_MCP_AUTH,
  fn: async () => {
    const res = await fetch(MCP, mcpBody("tools/call", { name: "create_todo", arguments: {} }, MCP_AUTH_HDR));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body.error);
    assertEquals(body.error.code, -32602);
  },
});

// ---------------------------------------------------------------------------
// documents-mcp-server (MCP JSON-RPC)
// ---------------------------------------------------------------------------

const DOCS_MCP = `${BASE}/documents-mcp-server`;

Deno.test("documents-mcp-server: no auth returns 401", async () => {
  const res = await fetch(DOCS_MCP, mcpBody("initialize"));
  assertEquals(res.status, 401);
  assertEquals(res.headers.get("www-authenticate")?.includes("resource_metadata"), true);
  await res.body?.cancel();
});

Deno.test("documents-mcp-server: rejects github.io OAuth redirect registration", async () => {
  const res = await fetch(`${DOCS_MCP}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://example.github.io/callback"] }),
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("documents-mcp-server: accepts chatgpt.com OAuth redirect registration", async () => {
  const redirectUri = "https://chatgpt.com/example/mcp/auth_callback";
  const res = await fetch(`${DOCS_MCP}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri] }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.redirect_uris, [redirectUri]);
});

Deno.test({
  name: "documents-mcp-server: tools/list returns note tools",
  ignore: !HAS_MCP_AUTH,
  fn: async () => {
    const res = await fetch(DOCS_MCP, mcpBody("tools/list", undefined, MCP_AUTH_HDR));
    assertEquals(res.status, 200);
    const body = await res.json();
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name).sort();
    assertEquals(names, ["read_markdown_note", "save_markdown_note", "search_markdown_note", "whoami"]);
  },
});

Deno.test({
  name: "documents-mcp-server: whoami returns connected OAuth user text",
  ignore: !HAS_MCP_AUTH,
  fn: async () => {
    const res = await fetch(DOCS_MCP, mcpBody("whoami", undefined, MCP_AUTH_HDR));
    assertEquals(res.status, 200);
    const body = await res.json();
    const text = body.result.content[0].text as string;
    assertEquals(text.includes("Connected as "), true);
    assertEquals(text.includes(" via "), true);
  },
});

Deno.test({
  name: "documents-mcp-server: save_markdown_note without title returns -32602",
  ignore: !HAS_MCP_AUTH,
  fn: async () => {
    const res = await fetch(
      DOCS_MCP,
      mcpBody("tools/call", { name: "save_markdown_note", arguments: { content: "no title" } }, MCP_AUTH_HDR),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body.error);
    assertEquals(body.error.code, -32602);
  },
});

Deno.test({
  name: "documents-mcp-server: save_markdown_note without content returns -32602",
  ignore: !HAS_MCP_AUTH,
  fn: async () => {
    const res = await fetch(
      DOCS_MCP,
      mcpBody("tools/call", { name: "save_markdown_note", arguments: { title: "no content" } }, MCP_AUTH_HDR),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body.error);
    assertEquals(body.error.code, -32602);
  },
});

Deno.test({
  name: "documents-mcp-server: search_markdown_note without query returns -32602",
  ignore: !HAS_MCP_AUTH,
  fn: async () => {
    const res = await fetch(
      DOCS_MCP,
      mcpBody("tools/call", { name: "search_markdown_note", arguments: {} }, MCP_AUTH_HDR),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body.error);
    assertEquals(body.error.code, -32602);
  },
});

Deno.test({
  name: "documents-mcp-server: read_markdown_note without title returns -32602",
  ignore: !HAS_MCP_AUTH,
  fn: async () => {
    const res = await fetch(
      DOCS_MCP,
      mcpBody("tools/call", { name: "read_markdown_note", arguments: {} }, MCP_AUTH_HDR),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body.error);
    assertEquals(body.error.code, -32602);
  },
});

Deno.test({
  name: "documents-mcp-server: save (create) → save (update) → search → read round-trip",
  ignore: !HAS_MCP_AUTH,
  fn: async () => {
    const uniqueTitle = `Integration Note ${Date.now()}`;

    // Create via save_markdown_note (title not yet known → insert)
    const createRes = await fetch(
      DOCS_MCP,
      mcpBody("tools/call", {
        name: "save_markdown_note",
        arguments: { title: uniqueTitle, content: "# Alpha\n\nInitial body" },
      }, MCP_AUTH_HDR),
    );
    assertEquals(createRes.status, 200);
    const createBody = await createRes.json();
    const createText: string = createBody.result.content[0].text;
    assertEquals(createText.includes("Added note"), true);
    assertEquals(createText.includes(uniqueTitle), true);

    // Update via save_markdown_note (same title → update)
    const updateRes = await fetch(
      DOCS_MCP,
      mcpBody("tools/call", {
        name: "save_markdown_note",
        arguments: { title: uniqueTitle, content: "# Beta\n\nSearch needle xyz" },
      }, MCP_AUTH_HDR),
    );
    assertEquals(updateRes.status, 200);
    const updateBody = await updateRes.json();
    const updateText: string = updateBody.result.content[0].text;
    assertEquals(updateText.includes("Updated note"), true);
    assertEquals(updateText.includes(uniqueTitle), true);

    // Search finds the note and exposes the title (no ID in output)
    const searchRes = await fetch(
      DOCS_MCP,
      mcpBody("tools/call", { name: "search_markdown_note", arguments: { query: "needle xyz" } }, MCP_AUTH_HDR),
    );
    assertEquals(searchRes.status, 200);
    const searchBody = await searchRes.json();
    const searchText: string = searchBody.result.content[0].text;
    assertEquals(searchText.includes(uniqueTitle), true);
    assertEquals(searchText.includes("ID:"), false);

    // Read by exact title returns full content
    const readRes = await fetch(
      DOCS_MCP,
      mcpBody("tools/call", { name: "read_markdown_note", arguments: { title: uniqueTitle } }, MCP_AUTH_HDR),
    );
    assertEquals(readRes.status, 200);
    const readBody = await readRes.json();
    const readText: string = readBody.result.content[0].text;
    assertEquals(readText.includes("# Beta"), true);
    assertEquals(readText.includes("Search needle xyz"), true);
    assertEquals(readText.includes(uniqueTitle), true);
    assertEquals(readText.includes("ID:"), false);
  },
});

Deno.test({
  name: "documents-mcp-server: read_markdown_note for nonexistent title returns not-found message",
  ignore: !HAS_MCP_AUTH,
  fn: async () => {
    const res = await fetch(
      DOCS_MCP,
      mcpBody("tools/call", {
        name: "read_markdown_note",
        arguments: { title: "This Title Does Not Exist XYZ999" },
      }, MCP_AUTH_HDR),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    const text: string = body.result.content[0].text;
    assertEquals(text.includes("No note found"), true);
  },
});

Deno.test({
  name: "documents-mcp-server: search_markdown_note for missing query returns no-match message",
  ignore: !HAS_MCP_AUTH,
  fn: async () => {
    const res = await fetch(
      DOCS_MCP,
      mcpBody("tools/call", {
        name: "search_markdown_note",
        arguments: { query: "zzz_no_such_note_xyz_999" },
      }, MCP_AUTH_HDR),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    const text: string = body.result.content[0].text;
    assertEquals(text.includes("No matching notes found"), true);
  },
});

Deno.test({
  name: "documents-mcp-server: unknown method returns JSON-RPC error -32601",
  ignore: !HAS_MCP_AUTH,
  fn: async () => {
    const res = await fetch(DOCS_MCP, mcpBody("unknown/method", undefined, MCP_AUTH_HDR));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body.error);
    assertEquals(body.error.code, -32601);
  },
});
