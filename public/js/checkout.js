/* Checkout page — shipping address + gr4vy Embed */

let embedInstance       = null;
let cartItems           = null;
let storedEmbedParams   = null;   // kept for address-triggered reinit
let addressBaked        = false;  // reinit happens at most once

const params  = new URLSearchParams(window.location.search);
const orderId = params.get('order_id');

if (!orderId) {
  window.location.href = '/';
}

// ── Fetch order details & backend config in parallel ───────────
async function init() {
  const [orderRes, configRes] = await Promise.all([
    fetch(`/api/orders/${orderId}`),
    fetch('/api/config'),
  ]);

  if (!orderRes.ok) {
    window.location.href = '/';
    return;
  }

  const order  = await orderRes.json();
  const config = await configRes.json();

  renderOrderSummary(order, config.products);
  setupAddressWatchers();
  await loadEmbedToken(order, config);
}

// ── Watch address fields; reinit embed with billing address once filled ──
function setupAddressWatchers() {
  ['addressLine1', 'city', 'postalCode'].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener('input',  maybeReinitEmbed);
    el.addEventListener('change', maybeReinitEmbed);
    el.addEventListener('blur',   maybeReinitEmbed);
  });
}

function isAddressFilled() {
  return ['addressLine1', 'city', 'postalCode']
    .every((id) => document.getElementById(id).value.trim().length > 0);
}

function maybeReinitEmbed() {
  // Only reinit once, only when embed is loaded and address is complete
  if (addressBaked || !storedEmbedParams || !embedInstance || !isAddressFilled()) return;
  addressBaked = true;

  // Tear down the current embed and remount with the address now pre-filled
  const container = document.getElementById('gr4vy-embed');
  container.innerHTML = '';
  embedInstance = null;
  document.getElementById('pay-btn').style.display = 'none';

  const { token, order, config, buyer, cartItems: items } = storedEmbedParams;
  setupEmbed(token, order, config, buyer, items);
}

// ── Render order summary panel ─────────────────────────────────
function renderOrderSummary(order, products) {
  const product = products?.find((p) => p.id === order.product_id);

  document.getElementById('order-loading').style.display = 'none';
  document.getElementById('order-details').style.display = 'block';

  document.getElementById('order-emoji').textContent         = product?.emoji ?? '📦';
  document.getElementById('order-product-name').textContent  = order.product_name;
  document.getElementById('order-customer-name').textContent = `${order.first_name} ${order.last_name}`;
  document.getElementById('order-subtotal').textContent      = formatCents(order.amount, order.currency);
  document.getElementById('order-total').textContent         = formatCents(order.amount, order.currency);
}

// ── Generate token + mount gr4vy Embed ────────────────────────
async function loadEmbedToken(order, config) {
  let token, buyer;
  try {
    const res = await fetch('/api/payment/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Token generation failed');
    token     = data.token;
    buyer     = data.buyer;
    cartItems = data.cartItems;
  } catch (err) {
    showEmbedError('Could not load the payment form: ' + err.message);
    return;
  }

  storedEmbedParams = { token, order, config, buyer, cartItems };
  mountEmbed(token, order, config, buyer, cartItems);
}

// ── Dynamically load gr4vy CDN script then mount Embed ─────────
function mountEmbed(token, order, config, buyer, cartItems) {
  const { gr4vyId, environment } = config;

  if (!gr4vyId) {
    showEmbedError('gr4vy is not configured (GR4VY_ID missing). Check your .env file.');
    return;
  }

  // CDN URL is always cdn.{gr4vyId}.gr4vy.app — no sandbox subdomain.
  // The environment (sandbox/production) is passed as a parameter to gr4vy.setup().
  const src = `https://cdn.${gr4vyId}.gr4vy.app/embed.latest.js`;

  const script = document.createElement('script');
  script.src = src;
  script.onload  = () => setupEmbed(token, order, config, buyer, cartItems);
  script.onerror = () => showEmbedError(`Could not load gr4vy Embed from ${src}. Verify your GR4VY_ID and environment.`);
  document.head.appendChild(script);
}

function setupEmbed(token, order, config, buyer, cartItems) {
  // Remove loading placeholder
  const placeholder = document.getElementById('embed-placeholder');
  if (placeholder) placeholder.remove();

  /* global gr4vy */
  // Show button immediately — optionsLoaded event will also show it, but this guarantees it appears
  document.getElementById('pay-btn').style.display = 'block';

  // Read address from form at embed setup time — pre-fills billing address in the card form
  const addr = getShippingAddress();
  const billingAddress = addr.line1 ? {
    line1:      addr.line1,
    line2:      addr.line2 || undefined,
    city:       addr.city,
    state:      addr.state || undefined,
    postalCode: addr.postalCode,
    country:    addr.country,
  } : undefined;

  embedInstance = gr4vy.setup({
    gr4vyId:               config.gr4vyId,
    environment:           config.environment ?? 'sandbox',
    ...(config.merchantAccountId ? { merchantAccountId: config.merchantAccountId } : {}),
    element:               '#gr4vy-embed',
    token:                 token,
    amount:                order.amount,
    currency:              order.currency ?? 'USD',
    country:               getSelectedCountry(),
    store:         true,
    paymentSource: 'ecommerce',
    metadata:      { checkout: 'true' },
    cartItems:     cartItems ?? [],
    ...(buyer ? {
      buyerExternalIdentifier: buyer.externalIdentifier,
      buyer: {
        displayName: `${buyer.firstName} ${buyer.lastName}`,
        billingDetails: {
          firstName:    buyer.firstName,
          lastName:     buyer.lastName,
          emailAddress: buyer.email,
          ...(buyer.mobile ? { phoneNumber: buyer.mobile } : {}),
          ...(billingAddress ? { address: billingAddress } : {}),
        },
      },
    } : {}),

    onBeforeTransaction: async () => {
      const billingAddress = getShippingAddress();
      try {
        await fetch('/api/payment/billing-details', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId, billingAddress }),
        });
      } catch (err) {
        console.warn('Could not update billing details:', err);
      }
      return {};
    },

    onComplete: async (transaction) => {
      await completePayment(transaction);
    },

    onEvent: (eventName, data) => {
      if (eventName === 'agumentError' || eventName === 'generalError') {
        console.error('gr4vy embed error:', eventName, data);
      }
      // Show Pay button once the embed has finished loading options
      if (eventName === 'optionsLoaded') {
        document.getElementById('pay-btn').style.display = 'block';
      }
      // Re-enable button if gr4vy rejects the submission (e.g. validation error)
      if (eventName === 'transactionFailed' || eventName === 'argumentError' || eventName === 'apiError') {
        const btn = document.getElementById('pay-btn');
        btn.disabled = false;
        btn.innerHTML = 'Pay now';
      }
    },
  });

  // Update country in embed when dropdown changes
  document.getElementById('country').addEventListener('change', () => {
    // gr4vy doesn't support live country updates; user needs to reload for new country
    // This is handled gracefully — the embed keeps the initial country
  });
}

// ── Payment complete callback ──────────────────────────────────
async function completePayment(transaction) {
  const shippingAddress = getShippingAddress();

  // Validate shipping address before we report success
  if (!validateShipping()) {
    showToast('Please complete your shipping address.');
    return;
  }

  try {
    const res = await fetch('/api/payment/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId,
        transactionId: transaction.id,
        status:        transaction.status,
        shippingAddress,
      }),
    });

    if (!res.ok) throw new Error('Failed to save payment details');

    window.location.href = `/confirmation.html?order_id=${orderId}`;
  } catch (err) {
    showToast('Payment recorded but redirect failed: ' + err.message);
    // Redirect anyway — order is captured
    setTimeout(() => {
      window.location.href = `/confirmation.html?order_id=${orderId}`;
    }, 2000);
  }
}

// ── Shipping form helpers ──────────────────────────────────────
function validateShipping() {
  const required = ['addressLine1', 'city', 'postalCode'];
  let ok = true;
  required.forEach((id) => {
    const el = document.getElementById(id);
    const err = document.getElementById('err-' + id);
    const valid = el.value.trim().length > 0;
    el.classList.toggle('error', !valid);
    if (err) err.classList.toggle('show', !valid);
    if (!valid) ok = false;
  });
  return ok;
}

function getShippingAddress() {
  return {
    line1:      document.getElementById('addressLine1').value.trim(),
    line2:      document.getElementById('addressLine2').value.trim(),
    city:       document.getElementById('city').value.trim(),
    state:      document.getElementById('state').value.trim(),
    postalCode: document.getElementById('postalCode').value.trim(),
    country:    document.getElementById('country').value,
  };
}

function getSelectedCountry() {
  return document.getElementById('country')?.value ?? 'US';
}

// ── Pay button handler ─────────────────────────────────────────
function submitPayment() {
  if (!validateShipping()) {
    showToast('Please complete your shipping address first.');
    return;
  }
  const btn = document.getElementById('pay-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Processing…';

  if (embedInstance) {
    embedInstance.submit();
  }
}

// Expose globally for onclick
window.submitPayment = submitPayment;

// ── Error display ──────────────────────────────────────────────
function showEmbedError(msg) {
  document.getElementById('embed-placeholder')?.remove();
  const errEl = document.getElementById('embed-error');
  document.getElementById('embed-error-text').textContent = msg;
  errEl.style.display = 'flex';
}

// ── Helpers ────────────────────────────────────────────────────
function formatCents(cents, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

function showToast(msg, duration = 3500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

init();
