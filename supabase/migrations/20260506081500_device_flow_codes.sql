create table if not exists public.device_codes (
  id uuid primary key default gen_random_uuid(),
  device_code text not null unique,
  user_code text not null unique,
  user_id uuid,
  status text not null default 'pending', -- pending, approved, denied, expired
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes'
);

create index if not exists device_codes_device_code_idx on public.device_codes(device_code);
create index if not exists device_codes_user_code_idx on public.device_codes(user_code);

alter table public.device_codes enable row level security;

-- Service role bypasses RLS for device flow operations
