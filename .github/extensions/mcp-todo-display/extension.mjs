// Extension: mcp-todo-display
// Display MCP todo tool results with proper formatting

import { joinSession } from "@github/copilot-sdk/extension";
import { createServer } from "http";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const SUPABASE_URL = "https://cqudsqhlchxoqcswxpol.supabase.co";
const GITHUB_CLIENT_ID = "Ov23liKNcP9aRVLsTHlo";
const CALLBACK_PORT = 3001;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`;

// Store JWT token in memory (persists during session)
let jwtToken = null;

async function openBrowser(url) {
    const commands = {
        darwin: `open "${url}"`,
        linux: `xdg-open "${url}"`,
        win32: `start "${url}"`
    };
    
    const cmd = commands[process.platform];
    if (!cmd) {
        throw new Error(`Unsupported platform: ${process.platform}`);
    }
    
    try {
        await execAsync(cmd);
    } catch (error) {
        console.error(`Failed to open browser: ${error}`);
    }
}

async function startOAuthFlow() {
    return new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
            const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
            
            if (url.pathname === "/callback") {
                const token = url.searchParams.get("access_token");
                
                if (token) {
                    jwtToken = token;
                    res.writeHead(200, { "Content-Type": "text/html" });
                    res.end(`
                        <html>
                            <head>
                                <title>Authentication Successful</title>
                                <style>
                                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; 
                                           display: flex; align-items: center; justify-content: center; height: 100vh; 
                                           margin: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
                                    .container { text-align: center; color: white; }
                                    h1 { margin: 0; }
                                    p { margin: 8px 0 0 0; opacity: 0.9; }
                                </style>
                            </head>
                            <body>
                                <div class="container">
                                    <h1>✓ Authenticated</h1>
                                    <p>You can now use todo commands in Copilot CLI.</p>
                                    <p>You can close this window.</p>
                                </div>
                            </body>
                        </html>
                    `);
                    server.close(() => resolve(token));
                } else {
                    res.writeHead(400, { "Content-Type": "text/plain" });
                    res.end("Authentication failed: no access token received");
                    server.close(() => reject(new Error("No access token received")));
                }
            } else {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("Not found");
            }
        });
        
        server.listen(CALLBACK_PORT, async () => {
            const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=github&client_id=${GITHUB_CLIENT_ID}&redirect_to=${encodeURIComponent(CALLBACK_URL)}&response_type=token&scope=read:user user:email`;
            
            console.log("Opening browser for authentication...");
            await openBrowser(authUrl);
        });
        
        setTimeout(() => {
            server.close();
            reject(new Error("OAuth timeout after 5 minutes"));
        }, 300000);
    });
}

async function getAuthToken() {
    if (jwtToken) {
        return jwtToken;
    }
    
    // Try to get token from environment variable (for CI/automation)
    const envToken = process.env.SUPABASE_ACCESS_TOKEN;
    if (envToken) {
        jwtToken = envToken;
        return jwtToken;
    }
    
    // Initiate OAuth flow
    console.log("Authentication required. Opening browser...");
    const token = await startOAuthFlow();
    return token;
}

async function callMCP(method, params = {}) {
    const token = await getAuthToken();
    
    const response = await fetch(`${SUPABASE_URL}/functions/v1/todo-mcp-server`, {
        method: "POST",
        headers: { 
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: { name: method, arguments: params }
        })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
        const error = data.error || data;
        throw new Error(
            typeof error === 'object' ? error.message : String(error)
        );
    }
    
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
