import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsOrigin = Deno.env.get("CORS_ALLOWED_ORIGIN") ?? "*";

const jsonHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": corsOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: jsonHeaders });
  }

  if (req.method !== "GET") {
    return jsonResponse(
      { error: "Method not allowed. Use GET." },
      405,
    );
  }

  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");

  const limit = limitParam !== null ? parseInt(limitParam, 10) : 100;
  const offset = offsetParam !== null ? parseInt(offsetParam, 10) : 0;

  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return jsonResponse(
      { error: 'Query parameter "limit" must be an integer between 1 and 1000.' },
      400,
    );
  }

  if (!Number.isInteger(offset) || offset < 0) {
    return jsonResponse(
      { error: 'Query parameter "offset" must be a non-negative integer.' },
      400,
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(
      { error: "Supabase function secrets are not configured." },
      500,
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const { data, error } = await supabase
    .from("todos")
    .select("id, title, completed, created_at")
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    return jsonResponse(
      { error: "Failed to list todos.", details: error.message },
      500,
    );
  }

  return jsonResponse({ todos: data, limit, offset }, 200);
}

if (import.meta.main) {
  Deno.serve(handler);
}
