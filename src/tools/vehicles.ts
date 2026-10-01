import { z } from "zod";
import { assertRecordInScope } from "../auth/company-scope.js";
import { defineTool, id, pageArgs, rowsOf, text } from "./define.js";

export const searchVehicles = defineTool({
  name: "drivo_search_vehicles",
  title: "Search vehicles",
  description: "Search dealer vehicle inventory by free text (stock no., VIN, plate, brand/model) and filters. Returns summary rows; use drivo_get_vehicle for detail.",
  scope: "drivo.vehicle.read",
  write: false,
  input: {
    search: text("Free text: stock no., VIN/chassis, plate, brand or model").optional(),
    status: text("Vehicle status", 30).optional(),
    brand_id: id("Brand id").optional(),
    model_id: id("Model id").optional(),
    year_min: z.number().int().min(1950).max(2100).optional(),
    year_max: z.number().int().min(1950).max(2100).optional(),
    price_min: z.number().min(0).optional(),
    price_max: z.number().min(0).optional(),
    fuel_type: text("Fuel type", 30).optional(),
    license_plate: text("Licence plate", 20).optional(),
    ...pageArgs,
  },
  handler: async (ctx, a) => {
    const r = await ctx.api.get("/api/v1/cars", a, { token: ctx.principal.upstreamToken, requestId: ctx.requestId });
    return { count: r.count ?? rowsOf(r.data).length, vehicles: rowsOf(r.data) };
  },
});

export const getVehicle = defineTool({
  name: "drivo_get_vehicle",
  title: "Get vehicle",
  description: "Full detail of one vehicle (product template id from drivo_search_vehicles). Includes product_variant_id, needed for drivo_create_booking. Internal cost/profit figures are withheld unless you hold drivo.finance.read.",
  scope: "drivo.vehicle.read",
  write: false,
  input: { vehicle_id: id("Vehicle (product template) id") },
  handler: async (ctx, a) => {
    const r = await ctx.api.get(`/api/v1/cars/${a.vehicle_id}`, {}, { token: ctx.principal.upstreamToken, requestId: ctx.requestId });
    assertRecordInScope(r.data, ctx.principal.companyIds, ctx.companyId);
    return { vehicle: r.data };
  },
});
