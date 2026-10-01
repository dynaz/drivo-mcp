import { z } from "zod";
import { defineTool, id, rowsOf } from "./define.js";

export const getServiceHistory = defineTool({
  name: "drivo_get_service_history",
  title: "Get service history",
  description: "Completed after-sales workshop jobs for a customer across all their vehicles.",
  scope: "drivo.service.read",
  write: false,
  input: { customer_id: id("Customer id") },
  handler: async (ctx, a) => {
    const r = await ctx.api.get(`/api/v1/customers/${a.customer_id}/service-history`, {}, { token: ctx.principal.upstreamToken, requestId: ctx.requestId });
    return { service_history: rowsOf(r.data, "service_history") };
  },
});

export const createServiceBooking = defineTool({
  name: "drivo_create_service_booking",
  title: "Create service booking",
  description:
    "Book a workshop service appointment for a customer's vehicle. If deal_id is given and that deal already has an open job, the existing job is returned instead of creating a duplicate. Idempotent on idempotency_key.",
  scope: "drivo.service.write",
  write: true,
  input: {
    customer_id: id("Customer id"),
    vehicle_id: id("Vehicle (product template) id"),
    deal_id: id("Originating deal id (links the visit to the sale)").optional(),
    appointment_at: z.string().regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/).optional().describe("YYYY-MM-DD HH:MM (UTC)"),
    requested_services: z.string().max(1000).optional(),
    customer_complaint: z.string().max(2000).optional(),
    mileage: z.number().min(0).max(2_000_000).optional().describe("Odometer at appointment"),
  },
  handler: async (ctx, a) => {
    const r = await ctx.api.post(
      "/api/v1/car-services",
      {
        service_customer_id: a.customer_id,
        service_product_id: a.vehicle_id,
        car_booking_id: a.deal_id,
        appointment_at: a.appointment_at,
        requested_services: a.requested_services,
        customer_complaint: a.customer_complaint,
        appointment_mileage: a.mileage,
      },
      { token: ctx.principal.upstreamToken, requestId: ctx.requestId },
    );
    return { service_booking: r.data };
  },
});
