-- The todos_user_id_fkey constraint was added outside of migrations (via the
-- Supabase dashboard) and prevents the MCP server from writing todos for
-- its fallback test user.  Drop it so user_id is a plain UUID column.
alter table public.todos drop constraint if exists todos_user_id_fkey;
