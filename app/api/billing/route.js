import { sql } from '@vercel/postgres';
import { requireAuth, respond, checkOrgAccess } from '../../../lib/auth';
import { PRODUCTS, checkEntitlement, canCreateOrg, recordPurchase, getUserPurchases, formatPrice, ensureBillingTable } from '../../../lib/billing';

export async function OPTIONS() {
  return new Response(null, { status: 200 });
}

export async function GET(request) {
  const user = await requireAuth(request);
  if (!user) return respond({ error: 'Not authenticated' }, 401);
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || '';

  // Return product catalog
  if (action === 'products') {
    const catalog = Object.values(PRODUCTS).map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: formatPrice(p.price_cents),
      price_cents: p.price_cents,
      type: p.type,
      scope: p.scope,
    }));
    return respond({ products: catalog });
  }

  // Check entitlement for a specific product
  if (action === 'check') {
    const productId = searchParams.get('product');
    const orgId = searchParams.get('org_id');
    if (!productId) return respond({ error: 'product required' }, 400);

    const product = PRODUCTS[productId];
    if (!product) return respond({ error: 'Unknown product' }, 400);

    if (productId === 'additional_org') {
      const result = await canCreateOrg(user.id);
      return respond({
        entitled: result.allowed,
        reason: result.reason,
        product: { ...product, price: formatPrice(product.price_cents) },
        orgCount: result.orgCount,
      });
    }

    const ent = await checkEntitlement(user.id, productId, orgId || null);
    return respond({
      entitled: ent.entitled,
      product: { ...product, price: formatPrice(product.price_cents) },
      purchase: ent.purchase,
    });
  }

  // Get purchase history
  if (action === 'history') {
    const purchases = await getUserPurchases(user.id);
    return respond({ purchases });
  }

  // Check if user can create another org
  if (action === 'can_create_org') {
    const result = await canCreateOrg(user.id);
    return respond(result);
  }

  return respond({ error: 'Unknown action' }, 400);
}

export async function POST(request) {
  try {
    const user = await requireAuth(request);
    if (!user) return respond({ error: 'Not authenticated' }, 401);
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || '';
    const input = await request.json().catch(() => ({}));

    // Request a purchase (soft paywall: sends contact/upgrade request)
    if (action === 'request_purchase') {
      const productId = input.product_id;
      const orgId = input.org_id || null;
      if (!productId) return respond({ error: 'product_id required' }, 400);

      const product = PRODUCTS[productId];
      if (!product) return respond({ error: 'Unknown product' }, 400);

      // Check if already purchased
      const existing = await checkEntitlement(user.id, productId, orgId);
      if (existing.entitled) {
        return respond({ ok: true, already_purchased: true, purchase: existing.purchase });
      }

      // Soft paywall: record as a contact/interest request
      // When Stripe is integrated, this would create a checkout session instead
      const useStripe = !!process.env.STRIPE_SECRET_KEY;

      if (useStripe) {
        // Future: Create Stripe checkout session
        // const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        // const session = await stripe.checkout.sessions.create({...});
        // return respond({ checkout_url: session.url, purchase_id: purchase.uuid });
        return respond({ error: 'Stripe integration coming soon' }, 501);
      }

      // Soft paywall — record interest, show contact info
      await ensureBillingTable();
      const purchase = await recordPurchase(user.id, productId, orgId, 'contact');
      console.log(`[BILLING] Purchase request: user=${user.email} product=${productId} org=${orgId} price=${formatPrice(product.price_cents)}`);

      return respond({
        ok: true,
        soft_paywall: true,
        message: 'Thank you for your interest! Contact us to complete your purchase.',
        contact_email: process.env.BILLING_CONTACT_EMAIL || 'billing@providentstrat.com',
        product: { ...product, price: formatPrice(product.price_cents) },
        purchase_id: purchase.uuid,
      });
    }

    // Admin: Grant access manually (super admin only)
    if (action === 'grant') {
      if (user.site_role !== 'super_admin') return respond({ error: 'Super admin only' }, 403);
      const targetUserId = input.user_id;
      const productId = input.product_id;
      const orgId = input.org_id || null;
      if (!targetUserId || !productId) return respond({ error: 'user_id and product_id required' }, 400);

      const purchase = await recordPurchase(targetUserId, productId, orgId, 'granted');
      return respond({ ok: true, purchase });
    }

    // Future: Stripe webhook handler
    if (action === 'webhook') {
      // const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      // const sig = request.headers.get('stripe-signature');
      // const event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
      // if (event.type === 'checkout.session.completed') { ... update purchase status ... }
      return respond({ received: true });
    }

    return respond({ error: 'Unknown action' }, 400);
  } catch (error) {
    console.error('Billing error:', error);
    return respond({ error: 'Server error: ' + error.message }, 500);
  }
}
