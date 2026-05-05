-- Enforce a maximum length of 500 characters on todos.title.
-- The existing NOT NULL + non-empty CHECK stays in place; this adds an upper bound.
alter table public.todos
  add constraint todos_title_max_length check (char_length(title) <= 500);
