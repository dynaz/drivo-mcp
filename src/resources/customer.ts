import type { McpServer, ResourceTemplate as RT } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Principal } from "../auth/api-key.js";
import type { ToolRuntime } from "../runtime/executor.js";
import { getCustomer } from "../tools/index.js";

/** drivo://customer/{id} — same authorisation + company isolation as drivo_get_customer (it calls the tool). */
export function registerCustomerResource(server: McpServer, runtime: ToolRuntime, principal: Principal, requestId: string, ResourceTemplate: typeof RT): void {
  server.registerResource(
    "customer",
    new ResourceTemplate("drivo://customer/{id}", { list: undefined }),
    { title: "Drivo customer", description: "One customer by id", mimeType: "application/json" },
    async (uri, vars) => {
      const r = await runtime.execute(getCustomer, { customer_id: Number(vars["id"]) }, principal, requestId);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(r.payload) }] };
    },
  );
}
