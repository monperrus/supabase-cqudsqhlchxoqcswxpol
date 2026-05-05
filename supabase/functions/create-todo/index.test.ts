import { assertEquals } from "jsr:@std/assert";
import { handler } from "./index.ts";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/create-todo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("handler OPTIONS: returns 200 ok for preflight", async () => {
  const req = new Request("http://localhost/create-todo", { method: "OPTIONS" });
  const res = await handler(req);
  assertEquals(res.status, 200);
});

Deno.test("handler: returns 405 for GET requests", async () => {
  const req = new Request("http://localhost/create-todo", { method: "GET" });
  const res = await handler(req);
  assertEquals(res.status, 405);
});

Deno.test("handler: returns 415 when Content-Type is not application/json", async () => {
  const req = new Request("http://localhost/create-todo", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "hello",
  });
  const res = await handler(req);
  assertEquals(res.status, 415);
});

Deno.test("handler: returns 400 for invalid JSON body", async () => {
  const req = new Request("http://localhost/create-todo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not-json",
  });
  const res = await handler(req);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "Request body must be valid JSON.");
});

Deno.test("handler: returns 400 when body is a JSON array", async () => {
  const res = await handler(makeRequest([{ title: "test" }]));
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "Request body must be a JSON object.");
});

Deno.test("handler: returns 400 when title is missing", async () => {
  const res = await handler(makeRequest({ completed: false }));
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'Field "title" is required and must be a non-empty string.');
});

Deno.test("handler: returns 400 when title is empty string", async () => {
  const res = await handler(makeRequest({ title: "   " }));
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'Field "title" is required and must be a non-empty string.');
});

Deno.test("handler: returns 400 when title exceeds 500 characters", async () => {
  const res = await handler(makeRequest({ title: "a".repeat(501) }));
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'Field "title" must not exceed 500 characters.');
});

Deno.test("handler: accepts title of exactly 500 characters (validation passes)", async () => {
  // The request will pass validation and fail only at the DB call (no secrets configured).
  const res = await handler(makeRequest({ title: "a".repeat(500) }));
  // Should reach the Supabase secrets check, not the title validation.
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "Supabase function secrets are not configured.");
});

Deno.test("handler: returns 400 when completed is not boolean", async () => {
  const res = await handler(makeRequest({ title: "My todo", completed: "yes" }));
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'Field "completed" must be a boolean when provided.');
});

Deno.test("handler: valid payload passes validation (reaches DB step)", async () => {
  const res = await handler(makeRequest({ title: "A valid todo" }));
  // Without Supabase secrets, should return 500 for missing secrets — not a 4xx.
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "Supabase function secrets are not configured.");
});
