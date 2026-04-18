import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const jsonHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

  if (req.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed. Use POST." },
      405,
    );
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return jsonResponse(
      { error: "Content-Type must be application/json." },
      415,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return jsonResponse(
        { error: "Request body must be valid JSON." },
        400,
      );
    }

    throw error;
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(
      { error: "Request body must be a JSON object." },
      400,
    );
  }

  const { title, completed } = body as Record<string, unknown>;
  const normalizedTitle = typeof title === "string" ? title.trim() : "";

  if (normalizedTitle.length === 0) {
    return jsonResponse(
      { error: 'Field "title" is required and must be a non-empty string.' },
      400,
    );
  }

  if (completed !== undefined && typeof completed !== "boolean") {
    return jsonResponse(
      { error: 'Field "completed" must be a boolean when provided.' },
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
    .insert({
      title: normalizedTitle,
      completed: completed ?? false,
    })
    .select("id, title, completed, created_at")
    .single();

  if (error) {
    return jsonResponse(
      { error: "Failed to create todo.", details: error.message },
      500,
    );
  }

  return jsonResponse({ todo: data }, 201);
});
