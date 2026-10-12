// Consumer bind guard (Phase 2B). The shared middleware runs every consumer of this service
// on ONE channel, and RabbitMQ closes a channel when it is asked to bind a queue to an
// exchange that does not exist (404 NOT_FOUND). That close silently kills every consumer
// already started on the channel (seen on DEV: product.events missing took down
// accounts.user.events and accounts.application.events).
//
// assertExchangeBindable() checks the exchange on a throwaway channel of the same
// connection first, so a missing exchange closes only that probe channel. It throws a clear
// error, which each consumer section's existing try/catch logs before continuing without
// that one consumer. It never creates an exchange: exchanges this service owns are declared
// in init({ exchanges }).
import { connectionManager } from "@projectShell/rabbitmq-middleware";

export async function assertExchangeBindable(exchange) {
  const connection = connectionManager.connection;
  if (!connection) throw new Error(`RabbitMQ connection unavailable; cannot bind to ${exchange}`);
  const probe = await connection.createChannel();
  probe.on("error", () => {}); // a 404 closes this probe channel only; the error is rethrown below
  try {
    await probe.checkExchange(exchange);
  } catch (error) {
    throw new Error(`exchange "${exchange}" does not exist; skipping this binding (${error.message})`);
  } finally {
    try {
      await probe.close();
    } catch {
      // already closed by the broker after a 404
    }
  }
}
