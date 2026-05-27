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

- `create-todo` — Validates a JSON payload with `title` (required) and `completed` (optional), then inserts a row into `public.todos` using the service role key. It returns the inserted row or a descriptive error.
- `list-todos` — Reads all todo records ordered by `id`. It requires the service role key and is intended for trusted server environments.

### todo-mcp-server

The `todo-mcp-server` is a complete OAuth 2.0 server with RFC 8628 Device Flow support for MCP (Model Context Protocol) clients. It authenticates users and provides tools to manage todos via JSON-RPC.

#### Device Flow (RFC 8628)

The Device Flow enables authentication for headless clients (CLI, daemons) without browser redirects.

**Step 1: Request Device Code**

```bash
curl -X POST https://cqudsqhlchxoqcswxpol.supabase.co/functions/v1/todo-mcp-server/device
```

Response:
```json
{
  "device_code": "C2FqxC5sF2...",
  "user_code": "ABCD-1234",
  "verification_uri": "https://cqudsqhlchxoqcswxpol.supabase.co/functions/v1/todo-mcp-server/verify",
  "verification_uri_complete": "https://cqudsqhlchxoqcswxpol.supabase.co/functions/v1/todo-mcp-server/verify?user_code=ABCD-1234",
  "expires_in": 900,
  "interval": 5
}
```

**Step 2: User Authorizes**

The user visits the `verification_uri` (optionally with `?user_code=...`) and enters the user code.

**Step 3: Poll for Token**

The client polls the `/token` endpoint every 5 seconds with the device code:

```bash
curl -X POST https://cqudsqhlchxoqcswxpol.supabase.co/functions/v1/todo-mcp-server/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
    "device_code": "C2FqxC5sF2..."
  }'
```

Possible responses:

- **Pending** (status 400): `{ "error": "authorization_pending" }` — User hasn't authorized yet
- **Expired** (status 400): `{ "error": "expired_token" }` — Code expired after 15 minutes
- **Success** (status 200): `{ "access_token": "...", "token_type": "bearer", "expires_in": 3600 }`

Once you receive an `access_token`, use it for MCP requests:

```bash
curl -X POST https://cqudsqhlchxoqcswxpol.supabase.co/functions/v1/todo-mcp-server \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list"
  }'
```

#### MCP Tools

Once authenticated, the server provides these tools:

- **whoami** — Show the connected OAuth username and OAuth origin/provider
- **list_todos** — List all todos for the authenticated user
- **create_todo** — Create a new todo (requires `title`)
- **update_todo** — Update a todo by ID (can update `title` and/or `completed`)
- **delete_todo** — Delete a todo by ID

It also supports the `user/info` JSON-RPC method, which returns the connected user's `id`, `username`, and `oauth_origin`.

### Required Secrets

Configure secrets in your Supabase project so the functions can reach your database or upstream APIs:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

You can set secrets locally with the CLI (replace `<project-ref>` and the placeholder values):

```bash
supabase functions secrets set --project-ref <project-ref> \
  SUPABASE_URL=... \
  SUPABASE_ANON_KEY=... \
  SUPABASE_SERVICE_ROLE_KEY=...
```

## License

MIT
