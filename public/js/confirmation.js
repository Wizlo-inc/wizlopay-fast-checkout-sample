/* Confirmation page — success state + upsell */

const params  = new URLSearchParams(window.location.search);
const orderId = params.get('order_id');

if (!orderId) {
  window.location.href = '/';
}

// Track which upsell products have been purchased this session
const purchased = new Set();

// ── Initialise ─────────────────────────────────────────────────
async function init() {
  const [orderRes, upsellRes] = await Promise.all([
    fetch(`/api/orders/${orderId}`),
    fetch('/api/upsell/products'),
  ]);

  if (!orderRes.ok) {
    window.location.href = '/';
    return;
  }

  const order   = await orderRes.json();
  const upsells = await upsellRes.json();

  renderSuccess(order);
  renderUpsells(upsells);
}

// ── Success card ───────────────────────────────────────────────
function renderSuccess(order) {
  document.getElementById('success-sub').textContent =
    `Thank you, ${order.first_name}! We've sent a confirmation to ${order.email}.`;

  const summaryEl = document.getElementById('order-summary');
  summaryEl.style.display = 'block';

  document.getElementById('conf-order-id').textContent = orderId.slice(0, 8).toUpperCase();
  document.getElementById('conf-product').textContent   = order.product_name;
  document.getElementById('conf-amount').textContent    = formatCents(order.amount, order.currency);
}

// ── Upsell section — always shown ─────────────────────────────
function renderUpsells(products) {
  const section = document.getElementById('upsell-section');
  const grid    = document.getElementById('upsell-grid');
  section.style.display = 'block';
  grid.innerHTML = '';

  products.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'upsell-card';
    card.id = `upsell-${p.id}`;

    card.innerHTML = `
      <div class="upsell-emoji">${p.emoji}</div>
      <div class="upsell-name">${p.name}</div>
      <div class="upsell-desc">${p.description}</div>
      <div class="upsell-price">${formatCents(p.amount, p.currency)}</div>
      <button class="btn btn-primary btn-sm" onclick="addUpsell('${p.id}', this)">
        Add to order
      </button>
    `;

    grid.appendChild(card);
  });
}

// ── One-click upsell charge ────────────────────────────────────
async function addUpsell(productId, btn) {
  if (purchased.has(productId)) return;

  const card = document.getElementById(`upsell-${productId}`);
  card.classList.add('loading');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  try {
    const res = await fetch('/api/upsell/charge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, productId }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error ?? 'Charge failed');
    }

    purchased.add(productId);
    card.classList.remove('loading');
    card.classList.add('bought');

    btn.innerHTML = '✓ Added';
    btn.className = 'btn btn-secondary btn-sm';
    btn.disabled  = true;

    showToast(`${data.product.name} added — ${formatCents(data.product.amount)}!`);

  } catch (err) {
    card.classList.remove('loading');
    btn.disabled = false;
    btn.innerHTML = 'Add to order';
    showToast('Could not complete charge: ' + err.message);
  }
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

window.addUpsell = addUpsell;

init();
