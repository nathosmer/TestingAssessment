import { sql } from '@vercel/postgres';

/**
 * Provident Billing & Entitlements Library
 *
 * Monetization features:
 *  - detailed_report: One-time PDF report purchase per org
 *  - additional_org: Unlock ability to create 2nd+ organizations
 *  - (future) premium_features, subscription tiers, etc.
 *
 * Currently uses a soft paywall (contact-to-upgrade).
 * When Stripe is added, purchase flow becomes:
 *   1. Frontend calls /api/billing?action=create_checkout
 *   2. Backend creates Stripe checkout session, returns URL
 *   3. User pays on Stripe
 *   4. Stripe webhook calls /api/billing?action=webhook → records purchase
 */

// Product catalog — prices in cents, configurable via env vars
export const PRODUCTS = {
  detailed_report: {
    id: 'detailed_report',
    name: 'Detailed PDF Report',
    description: 'Comprehensive multi-page assessment report with executive summary, section deep-dives, and actionable recommendations.',
    price_cents: parseInt(process.env.PRICE_DETAILED_REPORT || '4900', 10), // $49 default
    type: 'one_time',          // one_time | subscription
    scope: 'per_org',          // per_org | per_user | global
  },
  additional_org: {
    id: 'additional_org',
    name: 'Additional Organization',
    description: 'Add another organization to your account. Your first organization is always free.',
    price_cents: parseInt(process.env.PRICE_ADDITIONAL_ORG || '9900', 10), // $99 default
    type: 'one_time',
    scope: 'per_user',
  },
  // Future products can be added here
  // premium_plan: { id: 'premium_plan', name: 'Premium Plan', price_cents: 29900, type: 'subscription', scope: 'per_user' },
};

/**
 * Ensure the purchases table exists (run once per cold start).
 */
let tableVerified = false;
export async function ensureBillingTable() {
  if (tableVerified) return;
  try {
    await sql`CREATE TABLE IF NOT EXISTS purchases (
      id BIGSERIAL PRIMARY KEY,
      uuid VARCHAR(36) NOT NULL UNIQUE,
      user_id BIGINT NOT NULL,
      org_id BIGINT DEFAULT NULL,
      product_id VARCHAR(50) NOT NULL,
      amount_cents INT NOT NULL DEFAULT 0,
      currency VARCHAR(3) NOT NULL DEFAULT 'usd',
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      payment_method VARCHAR(20) DEFAULT 'contact',
      payment_ref VARCHAR(255) DEFAULT NULL,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ DEFAULT NULL
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_purchases_org ON purchases(org_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_purchases_product ON purchases(product_id)`;
    tableVerified = true;
  } catch (e) {
    console.warn('Billing table check:', e.message);
    tableVerified = true; // Assume exists
  }
}

/**
 * Check if a user has a specific entitlement.
 * Returns { entitled: boolean, purchase: row|null }
 */
export async function checkEntitlement(userId, productId, orgId = null) {
  await ensureBillingTable();
  try {
    let result;
    if (orgId) {
      // Per-org entitlement (e.g., detailed_report for a specific org)
      result = await sql`
        SELECT * FROM purchases
        WHERE user_id = ${userId} AND product_id = ${productId} AND org_id = ${orgId}
        AND status = 'completed'
        ORDER BY created_at DESC LIMIT 1
      `;
    } else {
      // Per-user entitlement (e.g., additional_org)
      result = await sql`
        SELECT * FROM purchases
        WHERE user_id = ${userId} AND product_id = ${productId}
        AND status = 'completed'
        ORDER BY created_at DESC LIMIT 1
      `;
    }
    if (result.rows.length > 0) {
      return { entitled: true, purchase: result.rows[0] };
    }
    return { entitled: false, purchase: null };
  } catch (e) {
    // Table may not exist yet in production
    return { entitled: false, purchase: null };
  }
}

/**
 * Count how many orgs a user owns (for gating additional orgs).
 */
export async function countUserOrgs(userId) {
  try {
    const result = await sql`SELECT COUNT(*) as cnt FROM organizations WHERE owner_id = ${userId} AND deleted_at IS NULL`;
    return parseInt(result.rows[0].cnt, 10);
  } catch (e) {
    return 0;
  }
}

/**
 * Check if user can create a new org (first is free, subsequent require purchase).
 */
export async function canCreateOrg(userId) {
  const orgCount = await countUserOrgs(userId);
  if (orgCount < 1) return { allowed: true, reason: 'first_org_free' };

  // Check if they've purchased additional org slots
  const ent = await checkEntitlement(userId, 'additional_org');
  if (ent.entitled) {
    // Count how many additional_org purchases vs how many orgs beyond 1
    try {
      const purchaseCount = await sql`
        SELECT COUNT(*) as cnt FROM purchases
        WHERE user_id = ${userId} AND product_id = 'additional_org' AND status = 'completed'
      `;
      const slots = parseInt(purchaseCount.rows[0].cnt, 10);
      if (orgCount < 1 + slots) {
        return { allowed: true, reason: 'purchased_slot' };
      }
    } catch (e) { /* fall through to denied */ }
  }

  return { allowed: false, reason: 'upgrade_required', orgCount, product: PRODUCTS.additional_org };
}

/**
 * Record a purchase (soft paywall: immediately grant as 'completed' with method 'contact').
 * When Stripe is integrated, this creates a 'pending' record that gets completed on webhook.
 */
export async function recordPurchase(userId, productId, orgId = null, method = 'granted', paymentRef = null) {
  await ensureBillingTable();
  const product = PRODUCTS[productId];
  if (!product) throw new Error('Unknown product: ' + productId);

  const uuid = crypto.randomUUID();
  const status = (method === 'granted' || method === 'contact') ? 'completed' : 'pending';

  const result = await sql`
    INSERT INTO purchases (uuid, user_id, org_id, product_id, amount_cents, currency, status, payment_method, payment_ref, completed_at)
    VALUES (${uuid}, ${userId}, ${orgId}, ${productId}, ${product.price_cents}, 'usd', ${status}, ${method}, ${paymentRef}, ${status === 'completed' ? new Date().toISOString() : null})
    RETURNING *
  `;
  return result.rows[0];
}

/**
 * Get all purchases for a user (for billing history).
 */
export async function getUserPurchases(userId) {
  await ensureBillingTable();
  try {
    const result = await sql`
      SELECT p.*, o.name as org_name
      FROM purchases p LEFT JOIN organizations o ON p.org_id = o.id
      WHERE p.user_id = ${userId}
      ORDER BY p.created_at DESC
    `;
    return result.rows;
  } catch (e) {
    return [];
  }
}

/**
 * Format price for display.
 */
export function formatPrice(cents) {
  return '$' + (cents / 100).toFixed(0);
}
