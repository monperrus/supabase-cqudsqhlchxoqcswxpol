create table public.proxy_logs (
  id           bigserial    primary key,
  created_at   timestamptz  not null default now(),
  mode         text         not null check (mode in ('managed', 'byok')),
  model        text,
  request      jsonb        not null,
  response     jsonb,
  status       integer      not null,
  api_key_prefix text,       -- first 10 chars of the BYOK key, null for managed mode
  upstream_base  text        -- upstream base URL actually used
);

-- Deny direct access from client roles; the proxy writes via the service role key.
alter table public.proxy_logs enable row level security;

create policy "no direct access"
  on public.proxy_logs
  as restrictive
  for all
  to anon, authenticated
  using (false);
