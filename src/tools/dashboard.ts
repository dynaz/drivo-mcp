import { defineTool, pageArgs, rowsOf } from "./define.js";
import { z } from "zod";

export const dashboardKpis = defineTool({
  name: "drivo_dashboard_kpis",
  title: "Dashboard KPIs",
  description: "Dealer dashboard headline numbers for the calling user (open bids, today's bookings, pending services, vehicle count, …).",
  scope: "drivo.sale.read",
  write: false,
  input: {},
  handler: async (ctx) => {
    const r = await ctx.api.get("/api/v1/dashboard", {}, { token: ctx.principal.upstreamToken, requestId: ctx.requestId });
    return { kpis: r.data };
  },
});

export const attentionCenter = defineTool({
  name: "drivo_attention_center",
  title: "Attention Center",
  description: "Items needing action now (overdue follow-ups, stalled deals, …) for the calling user.",
  scope: "drivo.sale.read",
  write: false,
  input: { scope: z.enum(["mine", "team"]).default("mine").describe("Your items or your team's (if RBAC allows)"), ...pageArgs },
  handler: async (ctx, a) => {
    const r = await ctx.api.get("/api/v1/attention", { scope: a.scope, limit: a.limit, offset: a.offset }, { token: ctx.principal.upstreamToken, requestId: ctx.requestId });
    return { count: r.count ?? rowsOf(r.data).length, items: r.data };
  },
});
