import { z } from "zod";
import { assertRecordInScope } from "../auth/company-scope.js";
import { defineTool, id, pageArgs, rowsOf, text } from "./define.js";

export const searchLeads = defineTool({
  name: "drivo_search_leads",
  title: "Search leads",
  description: "Search CRM leads/opportunities. Salespeople see only what Drivo RBAC allows them to see.",
  scope: "drivo.crm.read",
  write: false,
  input: {
    search: text("Free text over name, contact, phone, email").optional(),
    stage_id: id("Pipeline stage id").optional(),
    salesperson_id: id("Owner (user id)").optional(),
    activity_status: z.enum(["overdue", "today", "planned"]).optional(),
    created_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD"),
    created_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD"),
    ...pageArgs,
  },
  handler: async (ctx, a) => {
    const r = await ctx.api.get("/api/v1/leads", a, { token: ctx.principal.upstreamToken, requestId: ctx.requestId });
    return { count: r.count ?? rowsOf(r.data).length, leads: rowsOf(r.data) };
  },
});

export const getLead = defineTool({
  name: "drivo_get_lead",
  title: "Get lead",
  description: "Detail of one CRM lead.",
  scope: "drivo.crm.read",
  write: false,
  input: { lead_id: id("Lead id") },
  handler: async (ctx, a) => {
    const r = await ctx.api.get(`/api/v1/leads/${a.lead_id}`, {}, { token: ctx.principal.upstreamToken, requestId: ctx.requestId });
    assertRecordInScope(r.data, ctx.principal.companyIds, ctx.companyId);
    return { lead: r.data };
  },
});

export const createLead = defineTool({
  name: "drivo_create_lead",
  title: "Create lead",
  description: "Create a CRM lead owned by the calling user. Idempotent on idempotency_key.",
  scope: "drivo.crm.write",
  write: true,
  input: {
    name: text("Lead title, e.g. 'Somchai — Camry enquiry'", 200),
    customer_id: id("Existing customer id").optional(),
    contact_name: text("Contact name", 120).optional(),
    phone: text("Phone", 30).optional(),
    mobile: text("Mobile", 30).optional(),
    email: z.string().email().max(160).optional(),
    expected_revenue: z.number().min(0).max(1e9).optional(),
    priority: z.enum(["0", "1", "2", "3"]).optional().describe("0 normal … 3 very high"),
    notes: z.string().max(2000).optional(),
    vehicle_variant_id: id("Vehicle of interest: product_variant_id from drivo_get_vehicle").optional(),
  },
  handler: async (ctx, a) => {
    const r = await ctx.api.post(
      "/api/v1/leads",
      {
        name: a.name,
        partner_id: a.customer_id,
        contact_name: a.contact_name,
        phone: a.phone,
        mobile: a.mobile,
        email_from: a.email,
        planned_revenue: a.expected_revenue,
        priority: a.priority,
        description: a.notes,
        car_booking_id: a.vehicle_variant_id,
      },
      { token: ctx.principal.upstreamToken, requestId: ctx.requestId },
    );
    return { lead: r.data };
  },
});
