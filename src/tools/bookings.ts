import { z } from "zod";
import { defineTool, id, isoDate } from "./define.js";

export const createBooking = defineTool({
  name: "drivo_create_booking",
  title: "Create vehicle booking",
  description:
    "Reserve a vehicle for a customer (creates a draft deal/booking). HIGH-RISK: the first call returns a preview and a confirmation_token; show the preview to the user, then repeat the identical call with the token. Idempotent on idempotency_key.",
  scope: "drivo.sale.write",
  write: true,
  highRisk: true,
  input: {
    vehicle_variant_id: id("product_variant_id from drivo_get_vehicle"),
    customer_id: id("Customer id"),
    booking_date: isoDate("Booking date"),
    agreed_price: z.number().min(0).max(1e9).optional().describe("Agreed price in THB"),
    deposit: z.number().min(0).max(1e9).optional().describe("Deposit received in THB"),
    delivery_date: isoDate("Planned delivery date").optional(),
    lead_id: id("Source lead id").optional(),
  },
  preview: (a) => ({
    action: "Create draft vehicle booking",
    vehicle_variant_id: a.vehicle_variant_id,
    customer_id: a.customer_id,
    booking_date: a.booking_date,
    agreed_price_thb: a.agreed_price ?? "list price",
    deposit_thb: a.deposit ?? 0,
    delivery_date: a.delivery_date ?? null,
    effect: "Reserves the vehicle for this customer and creates a draft deal.",
  }),
  handler: async (ctx, a) => {
    const r = await ctx.api.post(
      "/api/v1/car-bookings",
      {
        car_booking_id: a.vehicle_variant_id,
        car_client_id: a.customer_id,
        car_booking_date: a.booking_date,
        car_price: a.agreed_price,
        car_partial_payment_amount: a.deposit,
        car_delivery_date: a.delivery_date,
        opportunity_id: a.lead_id,
      },
      { token: ctx.principal.upstreamToken, requestId: ctx.requestId },
    );
    return { booking: r.data };
  },
});
