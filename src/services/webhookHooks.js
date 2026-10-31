// Extension points the Stripe webhook calls after its lifecycle handling. Empty in the
// lifecycle prerequisite; the payment-link service registers its handlers here.
export const webhookHooks = {};

export function registerWebhookHooks(hooks) {
  Object.assign(webhookHooks, hooks);
}
