-- Add updated_at column to todos table for tracking mutation timestamps
alter table public.todos add column updated_at timestamptz not null default timezone('utc', now());

-- Backfill existing rows so updated_at matches created_at
update public.todos set updated_at = created_at where updated_at is null;
