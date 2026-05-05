// Extension: mcp-todo-display
// Display MCP todo tool results with proper formatting

import { joinSession } from "@github/copilot-sdk/extension";

async function callMCP(method, params = {}) {
    const response = await fetch("https://cqudsqhlchxoqcswxpol.supabase.co/functions/v1/todo-mcp-server", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: { name: method, arguments: params }
        })
    });
    const data = await response.json();
    return data.result;
}

const session = await joinSession({
    tools: [
        {
            name: "list-todos",
            description: "List all todos from the MCP server",
            parameters: { type: "object", properties: {} },
            skipPermission: true,
            handler: async () => {
                try {
                    const result = await callMCP("list_todos");
                    return result?.text || JSON.stringify(result, null, 2);
                } catch (error) {
                    return `Error: ${error instanceof Error ? error.message : String(error)}`;
                }
            },
        },
        {
            name: "create-todo",
            description: "Create a new todo",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description: "The title of the todo",
                    },
                },
                required: ["title"],
            },
            skipPermission: true,
            handler: async (args) => {
                try {
                    const result = await callMCP("create_todo", { title: args.title });
                    return result?.text || JSON.stringify(result, null, 2);
                } catch (error) {
                    return `Error: ${error instanceof Error ? error.message : String(error)}`;
                }
            },
        },
        {
            name: "update-todo",
            description: "Update a todo by ID or search by title",
            parameters: {
                type: "object",
                properties: {
                    id: {
                        type: "string",
                        description: "The ID of the todo to update, or a title substring to search for",
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
            skipPermission: true,
            handler: async (args) => {
                try {
                    let todoId = String(args.id);
                    
                    // If id is not numeric, search for todo by title
                    if (!/^\d+$/.test(todoId)) {
                        const listResult = await callMCP("list_todos");
                        const todos = listResult?.data || [];
                        const matching = todos.filter(t => 
                            t.title.toLowerCase().includes(todoId.toLowerCase())
                        );
                        if (matching.length === 1) {
                            todoId = String(matching[0].id);
                        } else if (matching.length > 1) {
                            return `Found ${matching.length} todos matching "${todoId}". Please be more specific.`;
                        } else {
                            return `No todos found matching "${todoId}".`;
                        }
                    }
                    
                    const params = { id: todoId };
                    if (args.title !== undefined) params.title = args.title;
                    if (args.completed !== undefined) params.completed = args.completed;
                    const result = await callMCP("update_todo", params);
                    return result?.text || JSON.stringify(result, null, 2);
                } catch (error) {
                    return `Error: ${error instanceof Error ? error.message : String(error)}`;
                }
            },
        },
        {
            name: "delete-todo",
            description: "Delete a todo",
            parameters: {
                type: "object",
                properties: {
                    id: {
                        type: "string",
                        description: "The ID of the todo to delete",
                    },
                },
                required: ["id"],
            },
            skipPermission: true,
            handler: async (args) => {
                try {
                    const result = await callMCP("delete_todo", { id: args.id });
                    return result?.text || JSON.stringify(result, null, 2);
                } catch (error) {
                    return `Error: ${error instanceof Error ? error.message : String(error)}`;
                }
            },
        },
    ],
});
