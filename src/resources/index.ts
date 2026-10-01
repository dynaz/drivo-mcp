import type { McpServer, ResourceTemplate as RT } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Principal } from "../auth/api-key.js";
import type { ToolRuntime } from "../runtime/executor.js";
import { registerVehicleResource } from "./vehicle.js";
import { registerCustomerResource } from "./customer.js";

export function registerResources(server: McpServer, runtime: ToolRuntime, principal: Principal, requestId: string, ResourceTemplate: typeof RT): void {
  registerVehicleResource(server, runtime, principal, requestId, ResourceTemplate);
  registerCustomerResource(server, runtime, principal, requestId, ResourceTemplate);
}
