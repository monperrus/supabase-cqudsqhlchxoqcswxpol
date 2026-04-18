drop policy if exists "deny_direct_todo_access" on public.todos;

create policy "deny_direct_todo_access"
on public.todos
for all
to anon, authenticated
using (false)
with check (false);
