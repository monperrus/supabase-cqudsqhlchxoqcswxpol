import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const skillMarkdown = `# Todo API Skill

## Overview
A simple Todo API built on Supabase Edge Functions. Use it to create and list todo items.

## Data Model

A **todo** object has the following fields:

| Field        | Type      | Description                              |
|--------------|-----------|------------------------------------------|
| id           | integer   | Auto-generated unique identifier         |
| title        | string    | Title of the todo (non-empty)            |
| completed    | boolean   | Whether the todo is done (default false) |
| created_at   | timestamp | ISO 8601 UTC timestamp of creation       |

## Endpoints

### List Todos

Retrieve all todo items in ascending order of creation.

- **Method:** \`GET\`
- **Path:** \`/functions/v1/list-todos\`
- **Auth:** Supabase anon key via \`Authorization: Bearer <anon-key>\` header

**Response 200**
\`\`\`json
{
  "todos": [
    {
      "id": 1,
      "title": "Buy groceries",
      "completed": false,
      "created_at": "2026-04-18T19:30:00.000Z"
    }
  ]
}
\`\`\`

---

### Create Todo

Create a new todo item.

- **Method:** \`POST\`
- **Path:** \`/functions/v1/create-todo\`
- **Auth:** Supabase anon key via \`Authorization: Bearer <anon-key>\` header
- **Content-Type:** \`application/json\`

**Request body**
\`\`\`json
{
  "title": "Buy groceries",
  "completed": false
}
\`\`\`

| Field     | Type    | Required | Description                              |
|-----------|---------|----------|------------------------------------------|
| title     | string  | yes      | Non-empty title for the todo             |
| completed | boolean | no       | Initial completion state (default false) |

**Response 201**
\`\`\`json
{
  "todo": {
    "id": 1,
    "title": "Buy groceries",
    "completed": false,
    "created_at": "2026-04-18T19:30:00.000Z"
  }
}
\`\`\`

**Error responses**

| Status | Condition                                      |
|--------|------------------------------------------------|
| 400    | Missing or empty title, invalid completed type |
| 405    | Wrong HTTP method                              |
| 415    | Content-Type is not application/json           |
| 500    | Server or database error                       |

## Usage Examples

\`\`\`bash
BASE_URL="https://<project-ref>.supabase.co"
ANON_KEY="<anon-key>"

# List todos
curl "$BASE_URL/functions/v1/list-todos" \\
  -H "Authorization: Bearer $ANON_KEY"

# Create a todo
curl -X POST "$BASE_URL/functions/v1/create-todo" \\
  -H "Authorization: Bearer $ANON_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"title": "Buy groceries"}'
\`\`\`
`;

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
    });
  }

  if (req.method !== "GET") {
    return new Response(
      JSON.stringify({ error: "Method not allowed. Use GET." }),
      {
        status: 405,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  return new Response(skillMarkdown, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
});
