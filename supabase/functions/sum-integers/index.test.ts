import { assertEquals } from "jsr:@std/assert";
import { parseInteger, handler } from "./index.ts";

Deno.test("parseInteger: returns integer for valid integer number", () => {
  assertEquals(parseInteger(42), 42);
  assertEquals(parseInteger(-7), -7);
  assertEquals(parseInteger(0), 0);
});

Deno.test("parseInteger: returns null for non-integer number", () => {
  assertEquals(parseInteger(3.14), null);
  assertEquals(parseInteger(NaN), null);
  assertEquals(parseInteger(Infinity), null);
});

Deno.test("parseInteger: parses valid integer strings", () => {
  assertEquals(parseInteger("5"), 5);
  assertEquals(parseInteger("-3"), -3);
  assertEquals(parseInteger("0"), 0);
});

Deno.test("parseInteger: returns null for non-integer strings", () => {
  assertEquals(parseInteger("3.14"), null);
  assertEquals(parseInteger(""), null);
  assertEquals(parseInteger("abc"), null);
  assertEquals(parseInteger("1e2"), null);
});

Deno.test("parseInteger: returns null for non-string, non-number types", () => {
  assertEquals(parseInteger(null), null);
  assertEquals(parseInteger(undefined), null);
  assertEquals(parseInteger(true), null);
  assertEquals(parseInteger([1]), null);
  assertEquals(parseInteger({}), null);
});

Deno.test("handler GET: returns A + 2*b for valid query params", async () => {
  const req = new Request("http://localhost/sum-integers?A=3&b=4");
  const res = await handler(req);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, { A: 3, b: 4, sum: 11 }); // 3 + 2*4 = 11
});

Deno.test("handler GET: case-insensitive A/a and b/B params", async () => {
  const req = new Request("http://localhost/sum-integers?a=2&B=5");
  const res = await handler(req);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, { A: 2, b: 5, sum: 12 }); // 2 + 2*5 = 12
});

Deno.test("handler GET: returns 400 for non-integer params", async () => {
  const req = new Request("http://localhost/sum-integers?A=foo&b=4");
  const res = await handler(req);
  assertEquals(res.status, 400);
});

Deno.test("handler GET: returns 400 when params are missing", async () => {
  const req = new Request("http://localhost/sum-integers?A=3");
  const res = await handler(req);
  assertEquals(res.status, 400);
});

Deno.test("handler POST: returns A + 2*b for valid JSON body", async () => {
  const req = new Request("http://localhost/sum-integers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ A: 10, b: 3 }),
  });
  const res = await handler(req);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, { A: 10, b: 3, sum: 16 }); // 10 + 2*3 = 16
});

Deno.test("handler: returns 405 for unsupported method", async () => {
  const req = new Request("http://localhost/sum-integers", { method: "DELETE" });
  const res = await handler(req);
  assertEquals(res.status, 405);
});

Deno.test("handler OPTIONS: returns 200 ok for preflight", async () => {
  const req = new Request("http://localhost/sum-integers", { method: "OPTIONS" });
  const res = await handler(req);
  assertEquals(res.status, 200);
});
