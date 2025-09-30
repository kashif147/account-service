import Stripe from "stripe";

const apiKey = process.env.STRIPE_SECRET_KEY || "";

const stripe = new Stripe(apiKey, {
  apiVersion: "2024-06-20",
});

export function getStripe() {
  return stripe;
}

export async function withIdempotency(fn, idempotencyKey) {
  return fn({ idempotencyKey });
}

export default stripe;
