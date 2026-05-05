import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// NOTE: This MCP server requires GitHub OAuth authentication.
// All todos are filtered by the authenticated user via RLS policies.
// The MCP client must provide a valid JWT token in the Authorization header.

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

async function callTool(req: MCPRequest, userId: string): Promise<MCPResponse> {
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
        const { data, error } = await supabase
          .from("todos")
          .select("id, title, completed, created_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: false });

        if (error) throw new Error(error.message);
        
        if (!data || data.length === 0) {
          return mcpResult(req.id, {
            success: true,
            data: [],
            text: "No todos found."
          });
        }
        
        const formatted = data.map((t: any, i: number) => {
          const status = t.completed ? "✅" : "⏳";
          return `${i + 1}. ${status} ${t.title}`;
        }).join("\n");
        
        return mcpResult(req.id, {
          success: true,
          data: data,
          text: formatted
        });
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
            user_id: userId,
          })
          .select("id, title, completed, created_at")
          .single();

        if (error) throw new Error(error.message);
        return mcpResult(req.id, {
          success: true,
          data: data,
          text: `Created todo: "${data.title}" (ID: ${data.id})`
        });
      }

      case "update_todo": {
        const id = args.id as string;
        const title = args.title as string | undefined;
        const completed = args.completed as boolean | undefined;

        if (!id || typeof id !== "string") {
          return mcpError(req.id, -32602, "id is required and must be a string");
        }

        const updateData: Record<string, unknown> = {};
        if (title !== undefined) updateData.title = title.trim();
        if (completed !== undefined) updateData.completed = completed;

        const { data, error } = await supabase
          .from("todos")
          .update(updateData)
          .eq("id", id)
          .eq("user_id", userId)
          .select("id, title, completed, created_at")
          .single();

        if (error) throw new Error(error.message);
        const status = data.completed ? "✅" : "⏳";
        return mcpResult(req.id, {
          success: true,
          data: data,
          text: `Updated todo: ${status} ${data.title}`
        });
      }

      case "delete_todo": {
        const id = args.id as string;

        if (!id || typeof id !== "string") {
          return mcpError(req.id, -32602, "id is required and must be a string");
        }

        const { error } = await supabase
          .from("todos")
          .delete()
          .eq("id", id)
          .eq("user_id", userId);

        if (error) throw new Error(error.message);
        return mcpResult(req.id, {
          success: true,
          data: { id: id },
          text: `Deleted todo with ID: ${id}`
        });
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

  if (!mcp.method || typeof mcp.method !== "string") {
    return jsonResponse(
      { error: "Invalid JSON-RPC request: missing or invalid method" },
      400,
    );
  }

  // For requests without id (notifications), use a default id if needed for internal processing
  const requestId = mcp.id ?? Date.now();

  // Extract user ID from JWT token (required for all requests)
  const authHeader = req.headers.get("authorization");
  let userId: string | null = null;
  
  if (!authHeader) {
    // Allow initialize and tools/list without auth, but require auth for tools/call
    if (mcp.method === "tools/call") {
      const response = mcpError(requestId, -32600, "Authorization required. Please sign in with GitHub.");
      if (mcp.id === undefined || mcp.id === null) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse(response, 401);
    }
  } else {
    try {
      const token = authHeader.replace("Bearer ", "");
      const parts = token.split(".");
      if (parts.length !== 3) {
        throw new Error("Invalid JWT format (expected 3 parts)");
      }
      
      // Decode URL-safe base64 (JWT format)
      const payloadBase64 = parts[1]
        .replace(/-/g, '+')
        .replace(/_/g, '/');
      const padding = '='.repeat((4 - (payloadBase64.length % 4)) % 4);
      const payload = JSON.parse(atob(payloadBase64 + padding));
      userId = payload.sub;
      
      if (!userId) {
        throw new Error("No user ID (sub) in token");
      }
    } catch (error) {
      const errorMsg = error && typeof error === 'object' && 'message' in error 
        ? (error as Error).message 
        : String(error);
      const response = mcpError(requestId, -32600, `Invalid token: ${errorMsg}`);
      if (mcp.id === undefined || mcp.id === null) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse(response, 401);
    }
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
        if (!userId) {
          response = mcpError(requestId, -32600, "Authorization required for tools/call");
        } else {
          response = await callTool(mcp, userId);
        }
        break;
      default:
        response = mcpError(requestId, -32601, `Unknown method: ${mcp.method}`);
    }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    response = mcpError(requestId, -32603, `Internal error: ${message}`);
  }

  // Only return response if the original request had an id
  if (mcp.id === undefined || mcp.id === null) {
    return new Response(null, { status: 204 });
  }

  return jsonResponse(response, 200);
});
