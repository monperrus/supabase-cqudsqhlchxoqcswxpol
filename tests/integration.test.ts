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
 * todo-mcp-server falls back to the TEST_USER_ID function secret when auth
 * fails; CI sets that secret to the same UUID.
 */

import { assertEquals, assertExists } from "jsr:@std/assert";

const BASE = "https://cqudsqhlchxoqcswxpol.supabase.co/functions/v1";

// Set by CI after creating / locating the integration-test auth user.
// When absent, any test that inserts into the DB is skipped.
const TEST_USER = Deno.env.get("SUPABASE_TEST_USER_ID") ?? "";
const HAS_USER = TEST_USER.length > 0;

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

function mcpBody(method: string, params?: Record<string, unknown>): RequestInit {
  const body: Record<string, unknown> = { jsonrpc: "2.0", id: 1, method };
  if (params !== undefined) body.params = params;
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// sum-integers
// ---------------------------------------------------------------------------

Deno.test("sum-integers GET: valid params → 200 with sum = A + 2*b", async () => {
  const res = await fetch(`${BASE}/sum-integers?A=3&b=4`);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { A: 3, b: 4, sum: 11 });
});

Deno.test("sum-integers GET: missing b → 400", async () => {
  const res = await fetch(`${BASE}/sum-integers?A=3`);
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("sum-integers GET: non-integer params → 400", async () => {
  const res = await fetch(`${BASE}/sum-integers?A=foo&b=bar`);
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("sum-integers POST: valid JSON → 200", async () => {
  const res = await fetch(`${BASE}/sum-integers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ A: 5, b: 2 }),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { A: 5, b: 2, sum: 9 });
});

Deno.test("sum-integers PUT → 405", async () => {
  const res = await fetch(`${BASE}/sum-integers`, { method: "PUT" });
  assertEquals(res.status, 405);
  await res.body?.cancel();
});

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

Deno.test("todo-mcp-server: initialize returns protocol version", async () => {
  const res = await fetch(MCP, mcpBody("initialize"));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.result.protocolVersion, "2024-11-05");
  assertEquals(body.result.serverInfo.name, "todo-mcp-server");
});

Deno.test("todo-mcp-server: tools/list returns the 4 expected tools", async () => {
  const res = await fetch(MCP, mcpBody("tools/list"));
  assertEquals(res.status, 200);
  const body = await res.json();
  const names: string[] = body.result.tools.map((t: { name: string }) => t.name).sort();
  assertEquals(names, ["create_todo", "delete_todo", "list_todos", "update_todo"]);
});

Deno.test("todo-mcp-server: list_todos returns content array", async () => {
  const res = await fetch(MCP, mcpBody("tools/call", { name: "list_todos", arguments: {} }));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertExists(body.result.content);
  assertEquals(Array.isArray(body.result.content), true);
});

Deno.test({
  name: "todo-mcp-server: create_todo then delete_todo round-trip",
  ignore: !HAS_USER,
  fn: async () => {
    // Create
    const createRes = await fetch(
      MCP,
      mcpBody("tools/call", { name: "create_todo", arguments: { title: "MCP Integration Test" } }),
    );
    assertEquals(createRes.status, 200);
    const createBody = await createRes.json();
    assertExists(createBody.result, `Expected result, got: ${JSON.stringify(createBody)}`);
    const text: string = createBody.result.content[0].text;
    const match = text.match(/\(ID: (\d+)\)/);
    assertExists(match, `Expected ID in response text, got: "${text}"`);
    const id = match[1];

    // Delete
    const deleteRes = await fetch(MCP, mcpBody("tools/call", { name: "delete_todo", arguments: { id } }));
    assertEquals(deleteRes.status, 200);
    const deleteBody = await deleteRes.json();
    assertEquals(deleteBody.result.content[0].text, `Deleted todo ID: ${id}`);
  },
});

Deno.test("todo-mcp-server: unknown method returns JSON-RPC error -32601", async () => {
  const res = await fetch(MCP, mcpBody("unknown/method"));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertExists(body.error);
  assertEquals(body.error.code, -32601);
});

Deno.test("todo-mcp-server: create_todo without title returns JSON-RPC error -32602", async () => {
  const res = await fetch(MCP, mcpBody("tools/call", { name: "create_todo", arguments: {} }));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertExists(body.error);
  assertEquals(body.error.code, -32602);
});
