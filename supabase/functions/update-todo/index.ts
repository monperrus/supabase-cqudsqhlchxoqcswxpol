import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const jsonHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "PATCH, OPTIONS",
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

  if (req.method !== "PATCH") {
    return jsonResponse(
      { error: "Method not allowed. Use PATCH." },
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

  const { id, title, completed } = body as Record<string, unknown>;

  if (!id || typeof id !== "string") {
    return jsonResponse(
      { error: 'Field "id" is required and must be a string.' },
      400,
    );
  }

  if (title === undefined && completed === undefined) {
    return jsonResponse(
      { error: 'At least one of "title" or "completed" must be provided.' },
      400,
    );
  }

  if (title !== undefined) {
    if (typeof title !== "string" || title.trim().length === 0) {
      return jsonResponse(
        { error: 'Field "title" must be a non-empty string when provided.' },
        400,
      );
    }
    if (title.trim().length > 500) {
      return jsonResponse(
        { error: 'Field "title" must not exceed 500 characters.' },
        400,
      );
    }
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

  const updateData: Record<string, unknown> = {};
  if (title !== undefined) updateData.title = (title as string).trim();
  if (completed !== undefined) updateData.completed = completed;

  const { data, error } = await supabase
    .from("todos")
    .update(updateData)
    .eq("id", id)
    .select("id, title, completed, created_at")
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      return jsonResponse(
        { error: `Todo with id "${id}" not found.` },
        404,
      );
    }
    return jsonResponse(
      { error: "Failed to update todo.", details: error.message },
      500,
    );
  }

  return jsonResponse({ todo: data }, 200);
});
