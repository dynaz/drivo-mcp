import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Principal } from "./auth/api-key.js";
import type { ToolRuntime } from "./runtime/executor.js";
import { ALL_TOOLS } from "./tools/index.js";
import { registerResources } from "./resources/index.js";

export const SERVER_INFO = { name: "drivo-erp", version: "0.1.0" } as const;

/** Build an MCP server bound to ONE authenticated principal (one per HTTP request, or per stdio process). */
export function createDrivoServer(runtime: ToolRuntime, principal: Principal, requestId: string): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Drivo dealer platform. Tools are business-domain operations scoped to the authenticated user and company. Write tools need an idempotency_key; high-risk writes need a human-confirmed preview token.",
  });

  for (const tool of ALL_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.fullShape,
        annotations: {
          readOnlyHint: !tool.write,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        const r = await runtime.execute(tool, args, principal, requestId);
        return { isError: r.isError, content: [{ type: "text" as const, text: JSON.stringify(r.payload) }] };
      },
    );
  }

  registerResources(server, runtime, principal, requestId, ResourceTemplate);
  return server;
}
