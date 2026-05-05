import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

interface MCPRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: string;
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

const jsonHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}

function mcpError(id: string | number, code: number, message: string): MCPResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

function mcpResult(id: string | number, result: unknown): MCPResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

async function initializeServer(req: MCPRequest): Promise<MCPResponse> {
  return mcpResult(req.id, {
    protocolVersion: "2024-11-05",
    capabilities: {
      tools: {
        listChanged: false,
      },
    },
    serverInfo: {
      name: "todo-mcp-server",
      version: "1.0.0",
    },
  });
}

async function listTools(req: MCPRequest): Promise<MCPResponse> {
  return mcpResult(req.id, {
    tools: [
      {
        name: "list_todos",
        description: "List all todos from the database",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "create_todo",
        description: "Create a new todo",
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "The title of the todo",
            },
            completed: {
              type: "boolean",
              description: "Whether the todo is completed (default: false)",
            },
          },
          required: ["title"],
        },
      },
      {
        name: "update_todo",
        description: "Update a todo",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The ID of the todo to update",
            },
            title: {
              type: "string",
              description: "The new title (optional)",
            },
            completed: {
              type: "boolean",
              description: "The new completed status (optional)",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "delete_todo",
        description: "Delete a todo",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The ID of the todo to delete",
            },
          },
          required: ["id"],
        },
      },
    ],
  });
}

async function callTool(req: MCPRequest): Promise<MCPResponse> {
  const { name, arguments: args } = req.params as {
    name: string;
    arguments: Record<string, unknown>;
  };

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return mcpError(req.id, -32603, "Supabase configuration missing");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  try {
    switch (name) {
      case "list_todos": {
        // TODO: unify sort order with the standalone list-todos function (currently
        // this orders by created_at DESC while list-todos orders by id ASC).
        const { data, error } = await supabase
          .from("todos")
          .select("id, title, completed, created_at")
          .order("created_at", { ascending: false });

        if (error) throw new Error(error.message);
        return mcpResult(req.id, { todos: data });
      }

      case "create_todo": {
        const title = args.title as string;
        const completed = args.completed as boolean | undefined;

        if (!title || typeof title !== "string" || title.trim().length === 0) {
          return mcpError(req.id, -32602, "title is required and must be a non-empty string");
        }

        const { data, error } = await supabase
          .from("todos")
          .insert({
            title: title.trim(),
            completed: completed ?? false,
          })
          .select("id, title, completed, created_at")
          .single();

        if (error) throw new Error(error.message);
        return mcpResult(req.id, { todo: data });
      }

      case "update_todo": {
        const id = args.id as string;
        const title = args.title as string | undefined;
        const completed = args.completed as boolean | undefined;

        if (!id || typeof id !== "string") {
          return mcpError(req.id, -32602, "id is required and must be a string");
        }

        // TODO: return an error when neither title nor completed is provided,
        // so callers receive useful feedback instead of a silent no-op update.

        // TODO: validate that title, when provided, is a non-empty string after
        // trimming, consistent with the create_todo validation.

        const updateData: Record<string, unknown> = {};
        if (title !== undefined) updateData.title = title.trim();
        if (completed !== undefined) updateData.completed = completed;

        const { data, error } = await supabase
          .from("todos")
          .update(updateData)
          .eq("id", id)
          .select("id, title, completed, created_at")
          .single();

        if (error) throw new Error(error.message);
        return mcpResult(req.id, { todo: data });
      }

      case "delete_todo": {
        const id = args.id as string;

        if (!id || typeof id !== "string") {
          return mcpError(req.id, -32602, "id is required and must be a string");
        }

        // TODO: check the number of rows affected and return a "not found" error
        // when no row matched the given id, instead of silently returning success.
        const { error } = await supabase
          .from("todos")
          .delete()
          .eq("id", id);

        if (error) throw new Error(error.message);
        return mcpResult(req.id, { success: true });
      }

      default:
        return mcpError(req.id, -32601, `Unknown method: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return mcpError(req.id, -32603, `Internal error: ${message}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: jsonHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed. Use POST." },
      405,
    );
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return jsonResponse(
      { error: "Content-Type must be application/json." },
      415,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return jsonResponse(
        { error: "Request body must be valid JSON." },
        400,
      );
    }
    throw error;
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(
      { error: "Request body must be a JSON object." },
      400,
    );
  }

  const mcp = body as MCPRequest;

  if (!mcp.jsonrpc || mcp.jsonrpc !== "2.0") {
    return jsonResponse(
      { error: "Invalid JSON-RPC request: missing or invalid jsonrpc field" },
      400,
    );
  }

  if (mcp.id === undefined || mcp.id === null) {
    return jsonResponse(
      { error: "Invalid JSON-RPC request: missing id" },
      400,
    );
  }

  if (!mcp.method || typeof mcp.method !== "string") {
    return jsonResponse(
      { error: "Invalid JSON-RPC request: missing or invalid method" },
      400,
    );
  }

  let response: MCPResponse;
  try {
    switch (mcp.method) {
      case "initialize":
        response = await initializeServer(mcp);
        break;
      case "tools/list":
        response = await listTools(mcp);
        break;
      case "tools/call":
        response = await callTool(mcp);
        break;
      default:
        response = mcpError(mcp.id, -32601, `Unknown method: ${mcp.method}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    response = mcpError(mcp.id, -32603, `Internal error: ${message}`);
  }

  return jsonResponse(response, 200);
});
