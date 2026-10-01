import { assertRecordInScope } from "../auth/company-scope.js";
import { defineTool, id, pageArgs, rowsOf, text } from "./define.js";

export const searchCustomers = defineTool({
  name: "drivo_search_customers",
  title: "Search customers",
  description: "Search customers by name, phone, mobile or email (phone numbers match across formats, e.g. 0812345678).",
  scope: "drivo.customer.read",
  write: false,
  input: { search: text("Name, phone or email"), ...pageArgs },
  handler: async (ctx, a) => {
    const r = await ctx.api.get("/api/v1/customers", a, { token: ctx.principal.upstreamToken, requestId: ctx.requestId });
    return { count: r.count ?? rowsOf(r.data).length, customers: rowsOf(r.data) };
  },
});

export const getCustomer = defineTool({
  name: "drivo_get_customer",
  title: "Get customer",
  description: "Customer 360 detail for one customer id.",
  scope: "drivo.customer.read",
  write: false,
  input: { customer_id: id("Customer (partner) id") },
  handler: async (ctx, a) => {
    const r = await ctx.api.get(`/api/v1/customers/${a.customer_id}`, {}, { token: ctx.principal.upstreamToken, requestId: ctx.requestId });
    assertRecordInScope(r.data, ctx.principal.companyIds, ctx.companyId);
    return { customer: r.data };
  },
});
