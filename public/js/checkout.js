/* Checkout page
 *
 *   Express (top):  Apple Pay · Google Pay · PayPal — shipping address is collected by the wallet
 *   Cards tab:      gr4vy Secure Fields → card vaulted into a checkout session → POST /api/payment/card
 *   BNPL tab:       Affirm · Klarna → POST /api/payment/redirect → provider → /api/payment/return
 */

const params  = new URLSearchParams(window.location.search);
const orderId = params.get('order_id');
if (!orderId) window.location.href = '/';

const state = {
  order:        null,
  config:       null,
  checkout:     null,   // response of /api/payment/init
  secureFields: null,
  fieldsValid:  { number: false, expiryDate: false, securityCode: false },
  busy:         false,
};

const CARD_SCHEMES = ['visa', 'mastercard', 'amex', 'discover'];

const BNPL_COPY = {
  affirm: { pill: 'Monthly payments', sub: (q) => `Pay in 4 interest-free payments of ${q}, or over 6–12 months.` },
  klarna: { pill: 'Interest-free',    sub: (q) => `Pay now, in 4 interest-free payments of ${q}, or over 3–12 months.` },
  paypalpaylater: { pill: 'Pay in 4', sub: (q) => `Pay in 4 interest-free payments of ${q} with PayPal.` },
  sezzle: { pill: 'Interest-free',    sub: (q) => `Pay in 4 interest-free payments of ${q} over 6 weeks.` },
};

// ── Boot ────────────────────────────────────────────────────────
async function init() {
  showReturnError();

  const [orderRes, configRes] = await Promise.all([
    fetch(`/api/orders/${orderId}`),
    fetch('/api/config'),
  ]);
  if (!orderRes.ok) { window.location.href = '/'; return; }

  state.order  = await orderRes.json();
  state.config = await configRes.json();
  renderOrderSummary(state.order, state.config.products);
  setupTabs();

  if (!state.config.gr4vyId) {
    showPaymentError('Payments are not configured (GR4VY_ID missing). Check your .env file.');
    return;
  }

  try {
    state.checkout = await postJSON('/api/payment/init', { orderId, country: getShippingAddress().country });
  } catch (err) {
    showPaymentError(err.message);
    hideExpress();
    return;
  }

  renderFooterLogos();
  renderBnpl(state.checkout.bnpl);
  setupCardForm();
  setupExpress(state.checkout.express);
}

// ── Tabs ────────────────────────────────────────────────────────
function setupTabs() {
  const tabs = document.querySelectorAll('.pay-tab');
  tabs.forEach((tab) => tab.addEventListener('click', () => selectTab(tab)));
  document.querySelector('.pay-tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const list = [...tabs];
    const next = list[(list.indexOf(document.activeElement) + 1) % list.length];
    next.focus();
    selectTab(next);
  });
}

function selectTab(tab) {
  document.querySelectorAll('.pay-tab').forEach((t) => {
    const active = t === tab;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
    t.tabIndex = active ? 0 : -1;
    document.getElementById(t.dataset.panel).hidden = !active;
  });
}

// ── Cards: Secure Fields ───────────────────────────────────────
function setupCardForm() {
  const payBtn = document.getElementById('pay-btn');
  payBtn.textContent = `Pay ${formatCents(state.order.amount, state.order.currency)}`;
  payBtn.addEventListener('click', submitCard);

  if (!state.checkout.card) {
    document.getElementById('panel-card').innerHTML = '<p class="empty-note">Card payments are not available for this order.</p>';
    return;
  }

  const { gr4vyId, environment } = state.config;
  const cdn = `https://cdn.${environment === 'production' ? '' : 'sandbox.'}${gr4vyId}.gr4vy.app/secure-fields/latest`;

  loadStylesheet(`${cdn}/secure-fields.css`);
  loadScript(`${cdn}/secure-fields.js`)
    .then(mountSecureFields)
    .catch(() => showPaymentError('Could not load the card form. Please refresh and try again.'));
}

function mountSecureFields() {
  /* global SecureFields */
  const { gr4vyId, environment } = state.config;
  const sf = new SecureFields({ gr4vyId, environment, sessionId: state.checkout.sessionId });
  state.secureFields = sf;

  const styles = {
    fontSize: '16px',
    color: '#181d27',
    padding: '0 16px',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    '::placeholder': { color: '#717680' },
  };

  const fields = [
    ['number',       '#cc-number', sf.addCardNumberField('#cc-number',  { placeholder: '1234 5678 9012 3456', styles })],
    ['expiryDate',   '#cc-expiry', sf.addExpiryDateField('#cc-expiry',  { placeholder: 'MM / YY', styles })],
    ['securityCode', '#cc-cvv',    sf.addSecurityCodeField('#cc-cvv',   { placeholder: 'CVV', styles })],
  ];

  fields.forEach(([key, selector, field]) => {
    const wrapper = document.querySelector(selector).closest('.card-field');
    field.addEventListener('focus', () => wrapper?.classList.add('focused'));
    field.addEventListener('blur',  () => wrapper?.classList.remove('focused'));
    field.addEventListener('input', (data) => {
      state.fieldsValid[key] = Boolean(data?.valid);
      refreshPayButton();
    });
  });

  sf.addEventListener(SecureFields.Events.CARD_VAULT_SUCCESS, chargeCard);
  sf.addEventListener(SecureFields.Events.CARD_VAULT_FAILURE, () => {
    setBusy(false);
    document.getElementById('card-fields').classList.add('invalid');
    document.getElementById('err-card').classList.add('show');
  });
}

function refreshPayButton() {
  const allValid = Object.values(state.fieldsValid).every(Boolean);
  document.getElementById('pay-btn').disabled = !allValid || state.busy;
  if (allValid) {
    document.getElementById('card-fields').classList.remove('invalid');
    document.getElementById('err-card').classList.remove('show');
  }
}

function submitCard() {
  if (!validateShipping()) {
    showToast('Please complete your shipping address first.');
    document.getElementById('addressLine1').focus();
    return;
  }
  clearPaymentError();
  setBusy(true, document.getElementById('pay-btn'));
  state.secureFields.submit();   // → CARD_VAULT_SUCCESS → chargeCard
}

async function chargeCard() {
  try {
    const result = await postJSON('/api/payment/card', { orderId, shippingAddress: getShippingAddress() });
    handlePaymentResult(result);
  } catch (err) {
    setBusy(false);
    showPaymentError(err.message);
  }
}

// ── BNPL ────────────────────────────────────────────────────────
function renderBnpl(options) {
  const list = document.getElementById('bnpl-list');
  const tabLogos = document.getElementById('bnpl-tab-logos');

  if (!options.length) {
    document.getElementById('tab-bnpl').hidden = true;
    document.querySelector('.pay-tabs').style.gridTemplateColumns = '1fr';
    return;
  }

  const quarter = formatCents(Math.ceil(state.order.amount / 4), state.order.currency);
  tabLogos.innerHTML = options.map((o) => `<img src="${o.iconUrl}" alt="${o.label}">`).join('');

  list.innerHTML = '';
  options.forEach((o) => {
    const copy = BNPL_COPY[o.method] ?? { pill: 'Pay over time', sub: () => 'Split your purchase into smaller payments.' };
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bnpl-option';
    btn.innerHTML = `
      <img src="${o.iconUrl}" alt="">
      <span class="bnpl-body">
        <span class="bnpl-name">${o.label} <span class="bnpl-pill">${copy.pill}</span></span>
        <span class="bnpl-sub" style="display:block">${copy.sub(quarter)}</span>
      </span>
      <svg class="bnpl-chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;
    btn.setAttribute('aria-label', `Pay with ${o.label}`);
    btn.addEventListener('click', () => startRedirect(o.method, btn, { needsAddress: true }));
    list.appendChild(btn);
  });
}

async function startRedirect(method, btn, { needsAddress }) {
  if (needsAddress && !validateShipping()) {
    showToast('Please complete your shipping address first.');
    document.getElementById('addressLine1').focus();
    return;
  }
  clearPaymentError();
  setBusy(true, btn);
  try {
    const result = await postJSON('/api/payment/redirect', {
      orderId,
      method,
      ...(needsAddress ? { shippingAddress: getShippingAddress() } : {}),
    });
    handlePaymentResult(result);
  } catch (err) {
    setBusy(false);
    showPaymentError(err.message);
  }
}

// ── Express: Apple Pay, Google Pay, PayPal ─────────────────────
async function setupExpress(options) {
  const container = document.getElementById('express-buttons');
  const byMethod = Object.fromEntries(options.map((o) => [o.method, o]));
  const buttons = [];

  if (byMethod.applepay) {
    const el = await buildApplePayButton(byMethod.applepay);
    if (el) buttons.push(el);
  }
  if (byMethod.googlepay) {
    const el = await buildGooglePayButton(byMethod.googlepay);
    if (el) buttons.push(el);
  }
  if (byMethod.paypal) buttons.push(buildPayPalButton(byMethod.paypal));

  container.innerHTML = '';
  if (!buttons.length) { hideExpress(); return; }
  buttons.forEach((b) => container.appendChild(b));
}

function hideExpress() {
  document.getElementById('express-card').style.display = 'none';
  document.getElementById('or-divider').style.display = 'none';
}

// PayPal — redirect; PayPal supplies the shipping address and gr4vy imports it.
function buildPayPalButton(option) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'express-btn express-btn-paypal';
  btn.setAttribute('aria-label', 'Pay with PayPal');
  btn.innerHTML = '<span class="paypal-wordmark"><span>Pay</span><span>Pal</span></span>';
  btn.addEventListener('click', () => startRedirect('paypal', btn, { needsAddress: false }));
  return btn;
}

// Google Pay — shipping address, email and phone collected in the Google Pay sheet.
async function buildGooglePayButton(option) {
  try {
    await loadScript('https://pay.google.com/gp/p/js/pay.js');
  } catch { return null; }

  const sandbox = state.config.environment !== 'production';
  const client = new google.payments.api.PaymentsClient({ environment: sandbox ? 'TEST' : 'PRODUCTION' });
  const ctx = option.context ?? {};
  const cardMethod = {
    type: 'CARD',
    parameters: {
      allowedAuthMethods: ['PAN_ONLY', 'CRYPTOGRAM_3DS'],
      allowedCardNetworks: (ctx.supportedSchemes ?? ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER'])
        .filter((s) => ['AMEX', 'DISCOVER', 'INTERAC', 'JCB', 'MASTERCARD', 'VISA'].includes(s)),
      billingAddressRequired: true,
      billingAddressParameters: { format: 'FULL', phoneNumberRequired: true },
    },
    tokenizationSpecification: {
      type: 'PAYMENT_GATEWAY',
      parameters: { gateway: ctx.gateway ?? 'gr4vy', gatewayMerchantId: ctx.gatewayMerchantId },
    },
  };

  try {
    const ready = await client.isReadyToPay({ apiVersion: 2, apiVersionMinor: 0, allowedPaymentMethods: [cardMethod] });
    if (!ready.result) return null;
  } catch { return null; }

  const onClick = async () => {
    clearPaymentError();
    let merchantInfo = { merchantName: ctx.merchantName ?? 'WizloShop' };
    try {
      const session = await postJSON('/api/payment/googlepay/session', { originDomain: location.hostname });
      if (session.authJwt) {
        // BCR2DN4T7C3KX6DY is gr4vy's Google Pay merchant ID (per gr4vy docs); the JWT authorizes this origin.
        merchantInfo = { ...merchantInfo, merchantId: 'BCR2DN4T7C3KX6DY', authJwt: session.authJwt, merchantOrigin: location.hostname };
      }
    } catch (err) { showPaymentError(err.message); return; }

    let paymentData;
    try {
      paymentData = await client.loadPaymentData({
        apiVersion: 2,
        apiVersionMinor: 0,
        allowedPaymentMethods: [cardMethod],
        merchantInfo,
        transactionInfo: {
          totalPriceStatus: 'FINAL',
          totalPrice: (state.order.amount / 100).toFixed(2),
          currencyCode: state.order.currency,
          countryCode: 'US',
        },
        emailRequired: true,
        shippingAddressRequired: true,
        shippingAddressParameters: { phoneNumberRequired: true },
      });
    } catch (err) {
      if (err?.statusCode !== 'CANCELED') showPaymentError('Google Pay could not be completed.');
      return;
    }

    const pm = paymentData.paymentMethodData;
    const shipping = fromGoogleAddress(paymentData.shippingAddress, paymentData.email);
    const billing  = fromGoogleAddress(pm.info?.billingAddress, paymentData.email);
    fillShippingForm(shipping);
    setBusy(true);
    try {
      const result = await postJSON('/api/payment/wallet', {
        orderId,
        method:     'googlepay',
        token:      pm.tokenizationData.token,
        cardSuffix: pm.info?.cardDetails,
        cardScheme: pm.info?.cardNetwork,
        shipping,
        billing,
      });
      handlePaymentResult(result);
    } catch (err) {
      setBusy(false);
      showPaymentError(err.message);
    }
  };

  const wrap = document.createElement('div');
  wrap.className = 'express-gpay';
  wrap.appendChild(client.createButton({ onClick, buttonType: 'buy', buttonColor: 'black', buttonSizeMode: 'fill' }));
  return wrap;
}

function fromGoogleAddress(a, email) {
  if (!a) return null;
  const [firstName, ...rest] = (a.name ?? '').trim().split(/\s+/);
  return {
    firstName:  firstName || undefined,
    lastName:   rest.join(' ') || undefined,
    email:      email || undefined,
    phone:      a.phoneNumber || undefined,
    line1:      a.address1 ?? '',
    line2:      [a.address2, a.address3].filter(Boolean).join(', ') || undefined,
    city:       a.locality ?? '',
    state:      a.administrativeArea || undefined,
    postalCode: a.postalCode ?? '',
    country:    a.countryCode ?? 'US',
  };
}

// Apple Pay — shipping contact collected in the Apple Pay sheet.
// Only renders on Apple Pay–capable browsers, over HTTPS, on a domain registered in gr4vy.
async function buildApplePayButton(option) {
  try {
    await loadScript('https://applepay.cdn-apple.com/jsapi/1.latest/apple-pay-sdk.js');
  } catch { return null; }
  try {
    // Throws on insecure (http) pages, so treat any error as "not available".
    if (!window.ApplePaySession || !ApplePaySession.canMakePayments() || !ApplePaySession.supportsVersion(3)) return null;
  } catch { return null; }

  const networks = (option.context?.supportedSchemes ?? ['visa', 'masterCard', 'amex', 'discover'])
    .filter((s) => ['visa', 'masterCard', 'amex', 'discover', 'jcb', 'interac', 'maestro'].includes(s));

  const btn = document.createElement('apple-pay-button');
  btn.setAttribute('buttonstyle', 'black');
  btn.setAttribute('type', 'buy');
  btn.setAttribute('locale', 'en-US');

  btn.addEventListener('click', () => {
    clearPaymentError();
    const total = { label: option.context?.merchantName ?? 'WizloShop', type: 'final', amount: (state.order.amount / 100).toFixed(2) };
    const session = new ApplePaySession(3, {
      countryCode: 'US',
      currencyCode: state.order.currency,
      merchantCapabilities: ['supports3DS'],
      supportedNetworks: networks,
      total,
      requiredShippingContactFields: ['postalAddress', 'name', 'email', 'phone'],
      requiredBillingContactFields: ['postalAddress', 'name'],
      shippingType: 'shipping',
    });

    session.onvalidatemerchant = async (event) => {
      try {
        const merchantSession = await postJSON('/api/payment/applepay/session', { validationUrl: event.validationURL });
        session.completeMerchantValidation(merchantSession);
      } catch (err) {
        session.abort();
        showPaymentError(err.message);
      }
    };

    session.onshippingcontactselected = () => {
      session.completeShippingContactSelection({ newTotal: total });   // shipping is free
    };

    session.onpaymentauthorized = async (event) => {
      const shipping = fromAppleContact(event.payment.shippingContact);
      const billing  = fromAppleContact(event.payment.billingContact);
      fillShippingForm(shipping);
      try {
        const result = await postJSON('/api/payment/wallet', {
          orderId,
          method:     'applepay',
          token:      event.payment.token,
          cardSuffix: event.payment.token?.paymentMethod?.displayName?.match(/\d{4}$/)?.[0],
          cardScheme: event.payment.token?.paymentMethod?.network,
          shipping,
          billing,
        });
        session.completePayment({ status: result.error ? ApplePaySession.STATUS_FAILURE : ApplePaySession.STATUS_SUCCESS });
        handlePaymentResult(result);
      } catch (err) {
        session.completePayment({ status: ApplePaySession.STATUS_FAILURE });
        showPaymentError(err.message);
      }
    };

    session.begin();
  });

  return btn;
}

function fromAppleContact(c) {
  if (!c) return null;
  const lines = c.addressLines ?? [];
  return {
    firstName:  c.givenName || undefined,
    lastName:   c.familyName || undefined,
    email:      c.emailAddress || undefined,
    phone:      c.phoneNumber || undefined,
    line1:      lines[0] ?? '',
    line2:      lines.slice(1).join(', ') || undefined,
    city:       c.locality ?? '',
    state:      c.administrativeArea || undefined,
    postalCode: c.postalCode ?? '',
    country:    (c.countryCode ?? 'US').toUpperCase(),
  };
}

// ── Shared result handling ─────────────────────────────────────
function handlePaymentResult(result) {
  if (result.approvalUrl) { window.location.href = result.approvalUrl; return; }   // 3DS / BNPL / PayPal
  if (result.redirect)    { window.location.href = result.redirect; return; }
  setBusy(false);
  showPaymentError(result.error ?? 'Payment was not approved. Please try another payment method.');
}

function showReturnError() {
  const code = params.get('payment_error');
  if (!code) return;
  const messages = {
    cancelled:  'Payment was cancelled. Choose a payment method to try again.',
    unverified: 'We could not confirm your payment. Please try again.',
  };
  showPaymentError(messages[code] ?? `Payment was not completed (${code.replace(/_/g, ' ')}). Please try another payment method.`);
  history.replaceState(null, '', `/checkout.html?order_id=${orderId}`);
}

// ── Footer logos ───────────────────────────────────────────────
function renderFooterLogos() {
  const { gr4vyId, environment } = state.config;
  const cdn = `https://cdn.${environment === 'production' ? '' : 'sandbox.'}${gr4vyId}.gr4vy.app/assets/icons`;
  const wallets = state.checkout.express.filter((o) => o.method !== 'paypal');

  document.getElementById('card-logos').innerHTML = [
    ...CARD_SCHEMES.map((s) => `<img src="${cdn}/card-schemes/${s}.svg" alt="${s}">`),
    ...wallets.map((o) => `<img src="${o.iconUrl}" alt="${o.label}">`),
  ].join('');

  const bnpl = state.checkout.bnpl;
  document.getElementById('bnpl-logos').innerHTML = bnpl.map((o) => `<img src="${o.iconUrl}" alt="${o.label}">`).join('');
  if (!bnpl.length) document.getElementById('bnpl-footer-title').style.display = 'none';
}

// ── Order summary ──────────────────────────────────────────────
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

// ── Shipping form helpers ──────────────────────────────────────
function validateShipping() {
  let ok = true;
  ['addressLine1', 'city', 'postalCode'].forEach((id) => {
    const el = document.getElementById(id);
    const valid = el.value.trim().length > 0;
    el.classList.toggle('error', !valid);
    document.getElementById('err-' + id)?.classList.toggle('show', !valid);
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

/** Mirror a wallet-provided address into the form so the buyer sees what was captured. */
function fillShippingForm(a) {
  if (!a) return;
  const set = (id, v) => { if (v) document.getElementById(id).value = v; };
  set('addressLine1', a.line1);
  set('addressLine2', a.line2);
  set('city', a.city);
  set('state', a.state);
  set('postalCode', a.postalCode);
  const country = document.getElementById('country');
  if ([...country.options].some((o) => o.value === a.country)) country.value = a.country;
}

// ── UI state ───────────────────────────────────────────────────
let busyEl = null;
function setBusy(busy, el) {
  state.busy = busy;
  if (busy && el) {
    busyEl = el;
    el.dataset.label = el.innerHTML;
    el.disabled = true;
    if (el.id === 'pay-btn') el.innerHTML = '<span class="spinner"></span> Processing…';
  } else if (!busy && busyEl) {
    busyEl.innerHTML = busyEl.dataset.label ?? busyEl.innerHTML;
    busyEl.disabled = false;
    busyEl = null;
  }
  refreshPayButton();
}

function showPaymentError(msg) {
  document.getElementById('payment-error-text').textContent = msg;
  const el = document.getElementById('payment-error');
  el.style.display = 'flex';
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearPaymentError() {
  document.getElementById('payment-error').style.display = 'none';
}

// ── Utils ──────────────────────────────────────────────────────
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) { existing.dataset.loaded ? resolve() : existing.addEventListener('load', resolve); return; }
    const s = document.createElement('script');
    s.src = src;
    if (src.includes('applepay.cdn-apple.com')) s.crossOrigin = 'anonymous';
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function loadStylesheet(href) {
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
}

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
