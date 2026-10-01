import { DrivoMcpError } from "../errors/mcp-error.js";
import { defineTool, id } from "./define.js";

export const getPayments = defineTool({
  name: "drivo_get_payments",
  title: "Get payments",
  description: "Payments / receivables for a deal (invoices, amounts, payment state) or the payment history of one invoice. Provide exactly one of deal_id or invoice_id.",
  scope: "drivo.finance.read",
  write: false,
  input: {
    deal_id: id("Deal (booking) id").optional(),
    invoice_id: id("Invoice id").optional(),
  },
  handler: async (ctx, a) => {
    if ((a.deal_id === undefined) === (a.invoice_id === undefined)) {
      throw new DrivoMcpError("invalid_input", "Provide exactly one of deal_id or invoice_id.", 400);
    }
    const path = a.deal_id ? `/api/v1/deals/${a.deal_id}/accounting` : `/api/v1/invoices/${a.invoice_id}/payments`;
    const r = await ctx.api.get(path, {}, { token: ctx.principal.upstreamToken, requestId: ctx.requestId });
    return { payments: r.data };
  },
});
