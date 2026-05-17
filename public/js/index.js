/* Personal details + product selection page */

const form = document.getElementById('details-form');
const productGrid = document.getElementById('product-grid');
const submitBtn = document.getElementById('submit-btn');

let selectedProductId = null;
let products = [];

// ── Load products from backend config ─────────────────────────
async function loadProducts() {
  const res = await fetch('/api/config');
  const config = await res.json();
  products = config.products;

  productGrid.innerHTML = '';
  products.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'product-card';
    card.dataset.id = p.id;
    card.innerHTML = `
      <div class="product-emoji">${p.emoji}</div>
      <div class="product-name">${p.name}</div>
      <div class="product-desc">${p.description}</div>
      <div class="product-price">${formatCents(p.amount, p.currency)}</div>
    `;
    card.addEventListener('click', () => selectProduct(p.id));
    productGrid.appendChild(card);
  });
}

function selectProduct(id) {
  selectedProductId = id;
  document.querySelectorAll('.product-card').forEach((c) => {
    c.classList.toggle('selected', c.dataset.id === id);
  });
  document.getElementById('err-product').classList.remove('show');
}

// ── Validation ─────────────────────────────────────────────────
function validateField(id, test) {
  const el = document.getElementById(id);
  const err = document.getElementById('err-' + id);
  const ok = test(el.value.trim());
  el.classList.toggle('error', !ok);
  err.classList.toggle('show', !ok);
  return ok;
}

function validate() {
  const ok = [
    validateField('firstName', (v) => v.length > 0),
    validateField('lastName',  (v) => v.length > 0),
    validateField('email',     (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)),
    validateField('mobile',    (v) => v.length >= 7),
  ];

  const productOk = !!selectedProductId;
  document.getElementById('err-product').classList.toggle('show', !productOk);
  return ok.every(Boolean) && productOk;
}

// ── Form submit ────────────────────────────────────────────────
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!validate()) return;

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="spinner"></span> Creating order…';

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName:  document.getElementById('firstName').value.trim(),
        lastName:   document.getElementById('lastName').value.trim(),
        email:      document.getElementById('email').value.trim(),
        mobile:     document.getElementById('mobile').value.trim(),
        productId:  selectedProductId,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Server error');

    window.location.href = `/checkout.html?order_id=${data.orderId}`;
  } catch (err) {
    showToast('Error: ' + err.message);
    submitBtn.disabled = false;
    submitBtn.innerHTML = 'Continue to checkout';
  }
});

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

loadProducts();
