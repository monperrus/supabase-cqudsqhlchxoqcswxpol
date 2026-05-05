import { assertEquals } from "jsr:@std/assert";
import { handler } from "./index.ts";

Deno.test("handler OPTIONS: returns 200 ok for preflight", async () => {
  const req = new Request("http://localhost/list-todos", { method: "OPTIONS" });
  const res = await handler(req);
  assertEquals(res.status, 200);
});

Deno.test("handler: returns 405 for POST requests", async () => {
  const req = new Request("http://localhost/list-todos", { method: "POST" });
  const res = await handler(req);
  assertEquals(res.status, 405);
});

Deno.test("handler GET: valid request without params passes validation (reaches DB step)", async () => {
  const req = new Request("http://localhost/list-todos");
  const res = await handler(req);
  // Secrets not configured in test env → 500 is expected after validation passes.
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "Supabase function secrets are not configured.");
});

Deno.test("handler GET: valid limit and offset params pass validation", async () => {
  const req = new Request("http://localhost/list-todos?limit=10&offset=20");
  const res = await handler(req);
  assertEquals(res.status, 500); // reaches DB step
  const body = await res.json();
  assertEquals(body.error, "Supabase function secrets are not configured.");
});

Deno.test("handler GET: returns 400 when limit is 0", async () => {
  const req = new Request("http://localhost/list-todos?limit=0");
  const res = await handler(req);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'Query parameter "limit" must be an integer between 1 and 1000.');
});

Deno.test("handler GET: returns 400 when limit exceeds 1000", async () => {
  const req = new Request("http://localhost/list-todos?limit=1001");
  const res = await handler(req);
  assertEquals(res.status, 400);
});

Deno.test("handler GET: returns 400 when limit is not an integer", async () => {
  const req = new Request("http://localhost/list-todos?limit=abc");
  const res = await handler(req);
  assertEquals(res.status, 400);
});

Deno.test("handler GET: returns 400 when offset is negative", async () => {
  const req = new Request("http://localhost/list-todos?offset=-1");
  const res = await handler(req);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'Query parameter "offset" must be a non-negative integer.');
});

Deno.test("handler GET: returns 400 when offset is not an integer", async () => {
  const req = new Request("http://localhost/list-todos?offset=foo");
  const res = await handler(req);
  assertEquals(res.status, 400);
});

Deno.test("handler GET: limit=1000 is valid (boundary)", async () => {
  const req = new Request("http://localhost/list-todos?limit=1000");
  const res = await handler(req);
  assertEquals(res.status, 500); // reaches DB step
});

Deno.test("handler GET: offset=0 is valid (boundary)", async () => {
  const req = new Request("http://localhost/list-todos?offset=0");
  const res = await handler(req);
  assertEquals(res.status, 500); // reaches DB step
});
