import type { McpServer, ResourceTemplate as RT } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Principal } from "../auth/api-key.js";
import type { ToolRuntime } from "../runtime/executor.js";
import { getVehicle } from "../tools/index.js";

/** drivo://vehicle/{id} — same authorisation + company isolation as drivo_get_vehicle (it calls the tool). */
export function registerVehicleResource(server: McpServer, runtime: ToolRuntime, principal: Principal, requestId: string, ResourceTemplate: typeof RT): void {
  server.registerResource(
    "vehicle",
    new ResourceTemplate("drivo://vehicle/{id}", { list: undefined }),
    { title: "Drivo vehicle", description: "One vehicle by id", mimeType: "application/json" },
    async (uri, vars) => {
      const r = await runtime.execute(getVehicle, { vehicle_id: Number(vars["id"]) }, principal, requestId);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(r.payload) }] };
    },
  );
}
