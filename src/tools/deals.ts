import { z } from "zod";
import { assertRecordInScope } from "../auth/company-scope.js";
import { defineTool, id, pageArgs, rowsOf, text } from "./define.js";

export const searchDeals = defineTool({
  name: "drivo_search_deals",
  title: "Search deals",
  description: "Search deals (car bookings / reservations) by free text, state or plate.",
  scope: "drivo.sale.read",
  write: false,
  input: {
    search: text("Booking no., customer, vehicle").optional(),
    state: text("Deal state", 30).optional(),
    car_plate_no: text("Licence plate", 20).optional(),
    ...pageArgs,
  },
  handler: async (ctx, a) => {
    const r = await ctx.api.get("/api/v1/car-bookings", a, { token: ctx.principal.upstreamToken, requestId: ctx.requestId });
    return { count: r.count ?? rowsOf(r.data).length, deals: rowsOf(r.data) };
  },
});

export const getDeal = defineTool({
  name: "drivo_get_deal",
  title: "Get deal",
  description: "Detail of one deal (booking) id.",
  scope: "drivo.sale.read",
  write: false,
  input: { deal_id: id("Deal (booking) id") },
  handler: async (ctx, a) => {
    const r = await ctx.api.get(`/api/v1/deals/${a.deal_id}`, {}, { token: ctx.principal.upstreamToken, requestId: ctx.requestId });
    assertRecordInScope(r.data, ctx.principal.companyIds, ctx.companyId);
    return { deal: r.data };
  },
});
