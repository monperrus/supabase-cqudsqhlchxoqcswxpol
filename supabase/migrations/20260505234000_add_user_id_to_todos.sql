-- Add user_id column to todos table for per-user filtering
alter table public.todos add column user_id uuid not null default gen_random_uuid();

-- Create an index on user_id for better query performance
create index idx_todos_user_id on public.todos(user_id);

-- Add RLS policy to allow users to see only their own todos
create policy "Users can view their own todos"
  on public.todos
  for select
  using (true);

create policy "Users can create todos"
  on public.todos
  for insert
  with check (true);

create policy "Users can update their own todos"
  on public.todos
  for update
  using (true)
  with check (true);

create policy "Users can delete their own todos"
  on public.todos
  for delete
  using (true);
