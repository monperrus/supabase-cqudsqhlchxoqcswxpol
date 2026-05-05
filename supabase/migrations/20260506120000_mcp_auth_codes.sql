create table if not exists public.mcp_auth_codes (
  id uuid primary key default gen_random_uuid(),
  mcp_code_challenge text not null,
  mcp_code_challenge_method text not null default 'S256',
  mcp_redirect_uri text not null,
  mcp_client_id text,
  mcp_state text,
  supabase_code_verifier text not null,
  supabase_access_token text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  used_at timestamptz
);

-- Service role bypasses RLS; no anon/authenticated access needed
alter table public.mcp_auth_codes enable row level security;
