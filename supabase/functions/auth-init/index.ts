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
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseAnonKey) {
    return jsonResponse(
      { error: "Supabase configuration missing" },
      500,
    );
  }

  // Extract the base URL from the request to construct the callback URL
  const url = new URL(req.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  const callbackUrl = `${baseUrl}/functions/v1/oauth-callback`;

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  try {
    // Get GitHub OAuth URL
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: callbackUrl,
        scopes: "user:email",
      },
    });

    if (error || !data.url) {
      throw error;
    }

    return jsonResponse(
      {
        success: true,
        auth_url: data.url,
        callback_url: callbackUrl,
      },
      200,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return jsonResponse(
      { error: `Failed to initiate OAuth: ${message}` },
      500,
    );
  }
});
