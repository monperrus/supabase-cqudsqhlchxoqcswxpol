import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const jsonHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

  if (req.method !== "GET") {
    return jsonResponse(
      { error: "Method not allowed. Use GET." },
      405,
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

  // Supabase automatically validates JWT when verify_jwt = true in config.toml
  // and provides req.auth with user info
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return jsonResponse(
      { error: "Authorization required. Please sign in with GitHub." },
      401,
    );
  }

  let userId: string | null = null;
  try {
    // Extract user ID from JWT token (format: "Bearer eyJ...")
    const token = authHeader.replace("Bearer ", "");
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid JWT format");
    }
    const payload = JSON.parse(atob(parts[1]));
    userId = payload.sub;
    
    if (!userId) {
      throw new Error("No user ID in token");
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

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const { data, error } = await supabase
    .from("todos")
    .select("id, title, completed, created_at")
    .eq("user_id", userId)
    .order("id", { ascending: true });

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const { data, error } = await supabase
    .from("todos")
    .select("id, title, completed, created_at")
    .eq("user_id", userId)
    .order("id", { ascending: true });

  if (error) {
    return jsonResponse(
      { error: "Failed to list todos.", details: error.message },
      500,
    );
  }

  return jsonResponse({ todos: data }, 200);
});
