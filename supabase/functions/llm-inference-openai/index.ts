import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const functionSlug = "llm-inference-openai";
const openRouterBaseUrl = "https://openrouter.ai/api";
// TODO: move legacyAnonKey out of source code — store it as a Supabase secret (e.g. LEGACY_ANON_KEY) and read via Deno.env.get().
const legacyAnonKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNxdWRzcWhsY2h4b3Fjc3d4cG9sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1MDc5NTEsImV4cCI6MjA5MjA4Mzk1MX0.iIhoW2v5IQN7AT8nj4qWjo50FqJH2LgEQf_2EjITg2A";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, accept, openai-beta",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

const hopByHopRequestHeaders = new Set([
  "apikey",
  "authorization",
  "connection",
  "content-length",
  "host",
  "x-client-info",
]);

const hopByHopResponseHeaders = new Set([
  "connection",
  "content-length",
  "transfer-encoding",
]);

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function isAuthorized(req: Request) {
  const expectedTokens = [
    Deno.env.get("SUPABASE_ANON_KEY"),
    legacyAnonKey,
  ].filter((token): token is string => Boolean(token));

  const authorization = req.headers.get("authorization");
  for (const token of expectedTokens) {
    if (authorization === `Bearer ${token}` || req.headers.get("apikey") === token) {
      return true;
    }
  }
  return false;
}

function getTargetPath(url: URL) {
  const prefixes = [
    `/${functionSlug}`,
    `/functions/v1/${functionSlug}`,
  ];

  for (const prefix of prefixes) {
    if (!url.pathname.startsWith(prefix)) {
      continue;
    }

    const targetPath = url.pathname.slice(prefix.length);
    return targetPath.length > 0 ? targetPath : "/";
  }

  return null;
}

function buildUpstreamHeaders(req: Request, openRouterApiKey: string) {
  const headers = new Headers();

  for (const [key, value] of req.headers.entries()) {
    if (hopByHopRequestHeaders.has(key.toLowerCase())) {
      continue;
    }

    headers.set(key, value);
  }

  headers.set("Authorization", `Bearer ${openRouterApiKey}`);

  const openRouterReferer = Deno.env.get("OPENROUTER_REFERER");
  if (openRouterReferer && !headers.has("HTTP-Referer")) {
    headers.set("HTTP-Referer", openRouterReferer);
  }

  const openRouterTitle = Deno.env.get("OPENROUTER_TITLE");
  if (openRouterTitle && !headers.has("X-OpenRouter-Title")) {
    headers.set("X-OpenRouter-Title", openRouterTitle);
  }

  return headers;
}

function buildDownstreamHeaders(upstreamHeaders: Headers) {
  const headers = new Headers(corsHeaders);

  for (const [key, value] of upstreamHeaders.entries()) {
    if (hopByHopResponseHeaders.has(key.toLowerCase())) {
      continue;
    }

    headers.set(key, value);
  }

  return headers;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!isAuthorized(req)) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  const url = new URL(req.url);
  const targetPath = getTargetPath(url);

  if (targetPath === null) {
    return jsonResponse({ error: "Invalid function path." }, 404);
  }

  if (targetPath === "/") {
    return jsonResponse({
      message: "OpenAI-compatible proxy for OpenRouter.",
      supported_path_prefix: "/v1",
    }, 200);
  }

  if (!targetPath.startsWith("/v1/")) {
    return jsonResponse(
      { error: 'Only "/v1/*" OpenAI-compatible paths are supported.' },
      404,
    );
  }

  const openRouterApiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!openRouterApiKey) {
    return jsonResponse(
      { error: "OPENROUTER_API_KEY is not configured for this function." },
      500,
    );
  }

  const upstreamUrl = new URL(`${openRouterBaseUrl}${targetPath}`);
  upstreamUrl.search = url.search;

  // TODO: add rate limiting to protect the OpenRouter quota from abuse.
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers: buildUpstreamHeaders(req, openRouterApiKey),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown upstream error.";
    return jsonResponse(
      { error: "Failed to reach OpenRouter.", details: message },
      502,
    );
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: buildDownstreamHeaders(upstreamResponse.headers),
  });
});
