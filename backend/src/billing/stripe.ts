/**
 * Stripe client wrapper.
 *
 * Exports a lazily-initialized Stripe instance.
 * If STRIPE_SECRET_KEY is not set, returns a mock that logs calls
 * without failing — so the server boots cleanly in development.
 */
import { config } from '../shared/config';
import { logger } from '../shared/logger';

let _stripe: any = null;

export function getStripe(): any {
  if (_stripe) return _stripe;

  if (!config.stripe.secretKey) {
    logger.warn('Stripe: STRIPE_SECRET_KEY not set — running in mock mode');
    _stripe = createMockStripe();
    return _stripe;
  }

  try {
    // Dynamic import so server boots without stripe if key not set
    const Stripe = require('stripe');
    _stripe = new Stripe(config.stripe.secretKey, {
      apiVersion: '2024-06-20',
      maxNetworkRetries: 2,
      timeout: 10_000,
    });
    logger.info('Stripe: client initialized');
  } catch (err) {
    logger.error({ err }, 'Stripe: failed to initialize — mock mode');
    _stripe = createMockStripe();
  }

  return _stripe;
}

export function isStripeConfigured(): boolean {
  return !!config.stripe.secretKey;
}

// ── Mock Stripe for development without API keys ──────────────────────────────
function createMockStripe() {
  const mock = new Proxy({}, {
    get: (_target, prop) => {
      // Return a sub-proxy for chained calls (e.g. stripe.customers.create)
      if (typeof prop === 'string') {
        return new Proxy({}, {
          get: (_t, method) => async (...args: unknown[]) => {
            logger.debug({ resource: prop, method, args: args.slice(0, 1) }, 'Stripe MOCK call');
            return createMockResponse(String(prop), String(method));
          },
        });
      }
    },
  });
  return mock;
}

function createMockResponse(resource: string, method: string): unknown {
  const id = `mock_${resource.slice(0, 4)}_${Date.now().toString(36)}`;
  switch (`${resource}.${method}`) {
    case 'customers.create':
      return { id, email: 'mock@example.com', object: 'customer' };
    case 'checkout.sessions.create':
      return { id, url: `http://localhost:5173/billing/mock-checkout?session=${id}`, object: 'checkout.session' };
    case 'billingPortal.sessions.create':
      return { id, url: `http://localhost:5173/billing/mock-portal?session=${id}`, object: 'billing_portal.session' };
    case 'subscriptions.retrieve':
    case 'subscriptions.update':
      return {
        id: `mock_sub_${Date.now().toString(36)}`,
        status: 'active',
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end:   Math.floor(Date.now() / 1000) + 30 * 86400,
        cancel_at_period_end: false,
        items: { data: [{ price: { id: 'mock_price', product: 'mock_product' } }] },
      };
    default:
      return { id, object: resource };
  }
}

// ── Webhook signature verification ────────────────────────────────────────────
export function constructWebhookEvent(
  rawBody: string,
  signature: string,
  secret: string,
): any {
  const stripe = getStripe();
  if (!isStripeConfigured()) {
    // In mock mode, parse the body directly (webhook testing)
    return JSON.parse(rawBody);
  }
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}
