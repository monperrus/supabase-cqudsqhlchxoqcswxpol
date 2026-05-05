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

  const { access_token } = body as Record<string, unknown>;

  if (!access_token || typeof access_token !== "string") {
    return jsonResponse(
      { error: "access_token is required" },
      400,
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseAnonKey) {
    return jsonResponse(
      { error: "Supabase configuration missing" },
      500,
    );
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  try {
    // Verify the token and get the user
    const { data, error } = await supabase.auth.getUser(access_token);

    if (error || !data.user) {
      return jsonResponse(
        { error: "Invalid or expired access token" },
        401,
      );
    }

    // Create a custom JWT for MCP server (valid for 1 hour)
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 3600;
    const header = { alg: "HS256", typ: "JWT" };
    const payload = {
      sub: data.user.id,
      email: data.user.email,
      iat: now,
      exp: exp,
    };

    // For now, use a simple approach - in production, you'd sign this properly
    // This is a placeholder JWT that the edge function will accept
    const headerB64 = btoa(JSON.stringify(header)).replace(/[+/=]/g, (m) => {
      const replacements: Record<string, string> = { "+": "-", "/": "_", "=": "" };
      return replacements[m] || m;
    });
    const payloadB64 = btoa(JSON.stringify(payload)).replace(/[+/=]/g, (m) => {
      const replacements: Record<string, string> = { "+": "-", "/": "_", "=": "" };
      return replacements[m] || m;
    });

    // For development, create a fake signature
    const signature = "dev-signature";
    const token = `${headerB64}.${payloadB64}.${signature}`;

    return jsonResponse(
      {
        success: true,
        access_token: token,
        user_id: data.user.id,
        email: data.user.email,
        expires_in: 3600,
      },
      200,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return jsonResponse(
      { error: `Authentication failed: ${message}` },
      500,
    );
  }
});
