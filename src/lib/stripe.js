import Stripe from "stripe";

const apiKey = process.env.STRIPE_SECRET_KEY || "";

const stripe = new Stripe(apiKey, {
  apiVersion: "2024-06-20",
  timeout: 20000, // 20 seconds timeout for Stripe API calls
  maxNetworkRetries: 2, // Retry up to 2 times on network errors
});

export function getStripe() {
  return stripe;
}

export async function withIdempotency(fn, idempotencyKey) {
  return fn({ idempotencyKey });
}

export default stripe;
