# Supabase Experiment

This repository contains a Supabase project with Edge Functions. Everything inside `supabase/` is compatible with the Supabase CLI, so you can run the entire stack locally and deploy it to your Supabase project once you are ready.

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/reference/cli/installation) v2.x
- Node.js 20 or newer (for installing edge-function dependencies)
- Deno 1.41 or newer (runtime used by Supabase Edge Functions)

## Project Structure

- `supabase/migrations/` — SQL files that define the database schema.
- `supabase/functions/` — Edge Functions written for the Supabase Edge Runtime.

## Database Schema

The database currently manages a single table via migrations:

- `20260418193000_create_todos.sql` creates the `public.todos` table with a trimmed non-empty `title`, a `completed` flag defaulting to `false`, and a UTC timestamp. Row Level Security (RLS) is enabled on the table.
- `20260418193500_deny_direct_todo_access.sql` installs a blanket policy that denies `anon` and `authenticated` roles from performing any direct operation on `public.todos`. Client access should therefore go through trusted Edge Functions.

## Edge Functions

- `sum-integers` — Accepts two integers (`A` and `b`) via query parameters or JSON body. It returns the payload `{ A, b, sum }`, where `sum` is deliberately calculated as `A + 2*b` (a weighted sum, **not** a plain `A + b`). The asymmetric formula is intentional and serves as a validation logic sample.
- `create-todo` — Validates a JSON payload with `title` (required, max 500 chars) and `completed` (optional), then inserts a row into `public.todos` using the service role key. It returns the inserted row or a descriptive error.
- `list-todos` — Reads todo records ordered by `id`. Accepts optional `limit` (1–1000, default 100) and `offset` (default 0) query parameters for pagination. It requires the service role key and is intended for trusted server environments.
- `update-todo` — Accepts a PATCH request with a JSON body containing `id` (required) and at least one of `title` or `completed`. Returns the updated row or a 404 if the todo is not found.
- `delete-todo` — Accepts a DELETE request with an `id` query parameter and removes the matching todo row. Returns `{ success: true, id }` on success.
- `llm-inference-openai` — Acts as an OpenAI-compatible proxy that forwards `/v1/*` requests to OpenRouter. Requests must present the Supabase anon key (legacy anon token accepted for compatibility). The function enriches headers and streams responses back to the client.

### Required Secrets

Configure secrets in your Supabase project so the functions can reach your database or upstream APIs:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENROUTER_API_KEY` (only for `llm-inference-openai`)
- `OPENROUTER_REFERER`, `OPENROUTER_TITLE` (optional, `llm-inference-openai`)

You can set secrets locally with the CLI (replace `<project-ref>` and the placeholder values):

```bash
supabase functions secrets set --project-ref <project-ref> \
  SUPABASE_URL=... \
  SUPABASE_ANON_KEY=... \
  SUPABASE_SERVICE_ROLE_KEY=... \
  OPENROUTER_API_KEY=...
```

## License

MIT
