// Export all event types and handlers from individual event files
export {
  JOURNAL_EVENTS,
  JOURNAL_QUEUES,
  handleJournalEvent,
} from "./journal.events.js";
export {
  BALANCE_EVENTS,
  BALANCE_QUEUES,
  handleBalanceEvent,
} from "./balance.events.js";
export {
  MEMBER_EVENTS,
  MEMBER_QUEUES,
  handleMemberEvent,
} from "./member.events.js";
export { INVOICE_EVENTS, handleInvoiceEvent } from "./invoice.events.js";
export { PAYMENT_EVENTS, handlePaymentEvent } from "./payment.events.js";
export {
  APPLICATION_EVENTS,
  handleApplicationEvent,
} from "./application.events.js";
export {
  REPORT_EVENTS,
  REPORT_QUEUES,
  handleReportEvent,
} from "./report.events.js";

// Combined event types for backward compatibility
export const EVENT_TYPES = {
  // Journal events
  ...JOURNAL_EVENTS,
  // Balance events
  ...BALANCE_EVENTS,
  // Member events
  ...MEMBER_EVENTS,
  // Invoice events
  ...INVOICE_EVENTS,
  // Payment events
  ...PAYMENT_EVENTS,
  // Application events
  ...APPLICATION_EVENTS,
  // Report events
  ...REPORT_EVENTS,
};

// Combined queue names
export const QUEUES = {
  ...JOURNAL_QUEUES,
  ...BALANCE_QUEUES,
  ...MEMBER_QUEUES,
  ...REPORT_QUEUES,
};
