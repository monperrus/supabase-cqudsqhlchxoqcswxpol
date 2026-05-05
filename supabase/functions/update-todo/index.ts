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


  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return jsonResponse(
      { error: "Authorization required. Please sign in with GitHub." },
      401,
    );
  }

  let userId: string | null = null;
  try {
    const token = authHeader.replace("Bearer ", "");
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid JWT format (expected 3 parts)");
    }
    
    // Decode URL-safe base64 (JWT format)
    const payloadBase64 = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const padding = '='.repeat((4 - (payloadBase64.length % 4)) % 4);
    const payload = JSON.parse(atob(payloadBase64 + padding));
    userId = payload.sub;
    
    if (!userId) {
      throw new Error("No user ID (sub) in token");
    }
  } catch (error) {
    const errorMsg = error && typeof error === 'object' && 'message' in error 
      ? (error as Error).message 
      : String(error);
    return jsonResponse(
      { error: `Invalid or expired token: ${errorMsg}` },
      401,
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

  const updateData: Record<string, unknown> = {};
  if (title !== undefined) {
    if (typeof title !== "string") {
      return jsonResponse(
        { error: 'Field "title" must be a string.' },
        400,
      );
    }
    updateData.title = title.trim();
  }

  if (completed !== undefined) {
    if (typeof completed !== "boolean") {
      return jsonResponse(
        { error: 'Field "completed" must be a boolean.' },
        400,
      );
    }
    updateData.completed = completed;
  }

  if (Object.keys(updateData).length === 0) {
    return jsonResponse(
      { error: "At least one field (title or completed) is required." },
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
    .update(updateData)
    .eq("id", id)
    .eq("user_id", userId)
    .select("id, title, completed, created_at")
    .single();

  if (error) {
    return jsonResponse(
      { error: "Failed to update todo. It may not exist or you may not have permission to update it." },
      500,
    );
  }

  if (!data) {
    return jsonResponse(
      { error: "Todo not found or you don't have permission to update it." },
      404,
    );
  }

  return jsonResponse({ todo: data }, 200);
});
