import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const jsonHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "DELETE, OPTIONS",
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: jsonHeaders });
  }

  if (req.method !== "DELETE") {
    return jsonResponse({ error: "Method not allowed. Use DELETE." }, 405);
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return jsonResponse({ error: "Authorization required. Please sign in with GitHub." }, 401);
  }

  let userId: string | null = null;
  try {
    const token = authHeader.replace("Bearer ", "");
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT format");
    const payloadBase64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (payloadBase64.length % 4)) % 4);
    const payload = JSON.parse(atob(payloadBase64 + padding));
    userId = payload.sub;
    if (!userId) throw new Error("No user ID in token");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: `Invalid or expired token: ${msg}` }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "Request body must be a JSON object." }, 400);
  }

  const { id } = body as Record<string, unknown>;
  if (!id || typeof id !== "string") {
    return jsonResponse({ error: 'Field "id" is required and must be a string.' }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Supabase function secrets are not configured." }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error, count } = await supabase
    .from("todos")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("user_id", userId);

  if (error) {
    return jsonResponse({ error: "Failed to delete todo." }, 500);
  }

  if (count === 0) {
    return jsonResponse({ error: "Todo not found or you don't have permission to delete it." }, 404);
  }

  return jsonResponse({ success: true }, 200);
});
