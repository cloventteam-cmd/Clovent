/**
 * Stripe Product + Price Setup Script
 *
 * Run ONCE after connecting Stripe to create all products and prices.
 * Outputs the price IDs you must set in .env.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_xxx npx tsx src/billing/stripe-setup.ts
 *
 * After running, add these to your .env:
 *   STRIPE_STARTER_MONTHLY_PRICE_ID=price_xxx
 *   STRIPE_STARTER_ANNUAL_PRICE_ID=price_xxx
 *   STRIPE_GROWTH_MONTHLY_PRICE_ID=price_xxx
 *   STRIPE_GROWTH_ANNUAL_PRICE_ID=price_xxx
 *   STRIPE_PRO_MONTHLY_PRICE_ID=price_xxx
 *   STRIPE_PRO_ANNUAL_PRICE_ID=price_xxx
 *   STRIPE_ENTERPRISE_MONTHLY_PRICE_ID=price_xxx
 *   STRIPE_ENTERPRISE_ANNUAL_PRICE_ID=price_xxx
 */
import 'dotenv/config';
import { PLANS, PLAN_ORDER, type PlanId } from './plans';

async function main() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    console.error('ERROR: STRIPE_SECRET_KEY not set in environment');
    process.exit(1);
  }

  const Stripe = require('stripe');
  const stripe = new Stripe(secretKey, { apiVersion: '2024-06-20' });

  console.log('\n🚀 CLOVENT Stripe Setup\n');
  console.log('Creating products and prices for 4 plans...\n');

  const output: Record<string, string> = {};

  for (const planId of PLAN_ORDER) {
    const plan = PLANS[planId];
    console.log(`\n── ${plan.name.toUpperCase()} ($${plan.monthly_price_usd}/mo) ─────────`);

    // Create or retrieve product
    const productList = await stripe.products.list({ limit: 100 });
    let product = productList.data.find((p: any) =>
      p.metadata?.clovent_plan === planId,
    );

    if (!product) {
      product = await stripe.products.create({
        name: `CLOVENT ${plan.name}`,
        description: plan.tagline,
        metadata: { clovent_plan: planId },
        features: plan.feature_bullets.slice(0, 5).map(name => ({ name })),
      });
      console.log(`  ✓ Product created: ${product.id}`);
    } else {
      // Update existing product
      product = await stripe.products.update(product.id, {
        name: `CLOVENT ${plan.name}`,
        description: plan.tagline,
      });
      console.log(`  ✓ Product found: ${product.id}`);
    }

    // Monthly price
    const monthlyPrices = await stripe.prices.list({ product: product.id, limit: 20 });
    let monthlyPrice = monthlyPrices.data.find((p: any) =>
      p.recurring?.interval === 'month' && p.metadata?.clovent_period === 'monthly',
    );

    if (!monthlyPrice) {
      monthlyPrice = await stripe.prices.create({
        product: product.id,
        currency: 'usd',
        unit_amount: plan.monthly_price_usd * 100,
        recurring: { interval: 'month' },
        metadata: { clovent_plan: planId, clovent_period: 'monthly' },
        nickname: `${plan.name} Monthly`,
      });
      console.log(`  ✓ Monthly price created: ${monthlyPrice.id} ($${plan.monthly_price_usd}/mo)`);
    } else {
      console.log(`  ✓ Monthly price found: ${monthlyPrice.id} ($${plan.monthly_price_usd}/mo)`);
    }

    // Annual price (billed monthly but committed annually)
    let annualPrice = monthlyPrices.data.find((p: any) =>
      p.recurring?.interval === 'year' || p.metadata?.clovent_period === 'annual',
    );

    if (!annualPrice) {
      annualPrice = await stripe.prices.create({
        product: product.id,
        currency: 'usd',
        unit_amount: plan.annual_price_usd * 12 * 100, // billed annually upfront
        recurring: { interval: 'year' },
        metadata: { clovent_plan: planId, clovent_period: 'annual' },
        nickname: `${plan.name} Annual ($${plan.annual_price_usd}/mo billed yearly)`,
      });
      console.log(`  ✓ Annual price created: ${annualPrice.id} ($${plan.annual_price_usd}/mo × 12)`);
    } else {
      console.log(`  ✓ Annual price found: ${annualPrice.id}`);
    }

    const envPrefix = planId.toUpperCase();
    output[`STRIPE_${envPrefix}_MONTHLY_PRICE_ID`] = monthlyPrice.id;
    output[`STRIPE_${envPrefix}_ANNUAL_PRICE_ID`]  = annualPrice.id;
  }

  console.log('\n\n✅ Setup complete! Add these to your .env file:\n');
  console.log('# ── Stripe Price IDs ──────────────────────────────────────────');
  for (const [key, value] of Object.entries(output)) {
    console.log(`${key}=${value}`);
  }
  console.log('');
}

main().catch(err => {
  console.error('\n❌ Setup failed:', err.message);
  process.exit(1);
});
