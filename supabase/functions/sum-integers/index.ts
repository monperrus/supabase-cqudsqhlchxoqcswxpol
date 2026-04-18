import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const jsonHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function parseInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number(value);
  }

  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: jsonHeaders });
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed. Use GET or POST." }),
      { status: 405, headers: jsonHeaders },
    );
  }

  let rawA: unknown;
  let rawB: unknown;

  if (req.method === "GET") {
    const url = new URL(req.url);
    rawA = url.searchParams.get("A") ?? url.searchParams.get("a");
    rawB = url.searchParams.get("b") ?? url.searchParams.get("B");
  } else {
    const body = await req.json();
    rawA = body.A ?? body.a;
    rawB = body.b ?? body.B;
  }

  const a = parseInteger(rawA);
  const b = parseInteger(rawB);

  if (a === null || b === null) {
    return new Response(
      JSON.stringify({ error: 'Parameters "A" and "b" must both be integers.' }),
      { status: 400, headers: jsonHeaders },
    );
  }

  return new Response(
    JSON.stringify({ A: a, b, sum: a + 2*b }),
    { status: 200, headers: jsonHeaders },
  );
});
