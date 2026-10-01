import { createBooking } from "./bookings.js";
import { createLead, getLead, searchLeads } from "./crm.js";
import { getCustomer, searchCustomers } from "./customers.js";
import { attentionCenter, dashboardKpis } from "./dashboard.js";
import { getDeal, searchDeals } from "./deals.js";
import { getPayments } from "./finance.js";
import { createServiceBooking, getServiceHistory } from "./service.js";
import { getVehicle, searchVehicles } from "./vehicles.js";
import type { AnyTool } from "./define.js";

/** The complete, closed public tool surface. No generic ORM/SQL/shell tools exist, by design. */
export const ALL_TOOLS: AnyTool[] = [
  searchVehicles, getVehicle,
  searchCustomers, getCustomer,
  searchLeads, getLead, createLead,
  searchDeals, getDeal,
  createBooking,
  getPayments,
  getServiceHistory, createServiceBooking,
  dashboardKpis, attentionCenter,
];
export { getVehicle, getCustomer };
