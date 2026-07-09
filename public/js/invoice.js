// === Invoice Page JS ===
document.getElementById('navbar-container').innerHTML = renderNavbar('invoice');

let currentInvoiceId = null;
let staffList = [];
let accountCustomers = [];
let _saving = false; // guard against concurrent saves / race conditions
let paymentLockReason = ''; // when set, PAID STATUS is hard-locked to OnAcc
let longTermPricingActive = false; // when true, LT auto price is in control
let pricingMode = 'manual'; // manual | longterm | account-rate-card | account-discount

// ─── Customer credit (early-return refunds) ────────────────────────────────
let existingCreditApplied = 0;   // credit_applied as loaded from the server (0 for a new booking)
let newlyStagedCredit = 0;       // amount staged via the "Apply" button THIS session, not yet consumed server-side
let availableCreditInfo = null;  // last lookup result, cached so Apply doesn't need to re-fetch

function syncPaymentReceivedDateUi() {
  const s1 = document.getElementById('inv-paid-status').value;
  const paid1 = s1 && s1 !== 'To Pay';
  document.getElementById('inv-payment-date-1-wrap').classList.toggle('d-none', !paid1);
  const splitOn = document.getElementById('split-payment-toggle').checked;
  const s2 = document.getElementById('inv-paid-status-2').value;
  const paid2 = splitOn && s2 && s2 !== 'To Pay';
  document.getElementById('inv-payment-date-2-wrap').classList.toggle('d-none', !paid2);
}

function ensurePaymentDateDefaults() {
  const el1 = document.getElementById('inv-payment-date-1');
  const el2 = document.getElementById('inv-payment-date-2');
  const s1 = document.getElementById('inv-paid-status').value;
  if (s1 && s1 !== 'To Pay' && el1 && !el1.value) el1.value = localDateStr(new Date());
  const s2 = document.getElementById('inv-paid-status-2').value;
  if (document.getElementById('split-payment-toggle').checked && s2 && s2 !== 'To Pay' && el2 && !el2.value) {
    el2.value = localDateStr(new Date());
  }
}

// ─── Customer alert helpers (robust if elements missing) ──────────────────────
function getCustomerAlertElement() {
  return document.getElementById('customer-alert-text');
}

function getCustomerAlertDisplay() {
  return document.getElementById('customer-alert-display');
}

function getCustomerAlertText() {
  const el = getCustomerAlertElement();
  return el ? (el.textContent || '') : '';
}

function setCustomerAlertText(text) {
  const el = getCustomerAlertElement();
  const box = getCustomerAlertDisplay();
  if (!el || !box) return; // fail-safe if HTML is out of sync
  el.textContent = text || '';
  box.classList.toggle('d-none', !text);
}

const KEY_AVOID_SESSION_KEY = 'invoiceKeyAvoidNextOpen';

/** Rebuild KEY # from /api/keybox/available. When opening a fresh draft, optionally pick lowest key that differs from previousKeyToAvoid (e.g. other tab). */
async function populateKeySelectFromAvailable({ selectFirstAvailable = false, previousKeyToAvoid = null } = {}) {
  const keyRes = await fetch('/api/keybox/available');
  const keySel = document.getElementById('inv-key-number');
  keySel.innerHTML = '<option value="">No Key</option>';
  if (!keyRes.ok) return;
  const keys = await keyRes.json();
  keys.forEach((k) => {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = `Key ${k}`;
    keySel.appendChild(opt);
  });
  if (!selectFirstAvailable || keys.length === 0) return;
  const noKeyEl = document.getElementById('inv-no-key');
  noKeyEl.checked = false;
  keySel.disabled = false;
  let pick = keys[0];
  if (previousKeyToAvoid != null && String(previousKeyToAvoid) !== '') {
    const alt = keys.find((k) => String(k) !== String(previousKeyToAvoid));
    if (alt != null) pick = alt;
  }
  keySel.value = pick;
}

async function initInvoicePage() {
  const user = await checkAuth();
  if (!user) return;

  // Load staff list
  const staffRes = await fetch('/api/admin/staff-list');
  if (staffRes.ok) {
    staffList = await staffRes.json();
    const staffSel = document.getElementById('inv-staff');
    staffList.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      if (s.id === user.id) opt.selected = true;
      staffSel.appendChild(opt);
    });
  }

  // Load account customers
  const acctRes = await fetch('/api/accounts');
  if (acctRes.ok) {
    accountCustomers = await acctRes.json();
    const acctSel = document.getElementById('inv-account-customer');
    accountCustomers.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.company_name;
      acctSel.appendChild(opt);
    });
  }

  const params = new URLSearchParams(window.location.search);
  let keyAvoidFromOtherTab = null;
  try {
    keyAvoidFromOtherTab = sessionStorage.getItem(KEY_AVOID_SESSION_KEY);
    sessionStorage.removeItem(KEY_AVOID_SESSION_KEY);
  } catch (_) {}

  await populateKeySelectFromAvailable({
    selectFirstAvailable: !params.get('id'),
    previousKeyToAvoid: keyAvoidFromOtherTab
  });

  // Check URL params for loading existing invoice
  if (params.get('id')) {
    await loadInvoice(null, params.get('id'));
  } else {
    await newInvoice();
  }

  updateNavCarsCount();
  loadFlightsForDate(document.getElementById('inv-return-date').value);
}

// ─── Live flight dropdown from Air NZ (BOI/KKE) ──────────────────────────────
async function loadFlightsForDate(dateStr) {
  const sel = document.getElementById('inv-flight-arrival-select');
  if (!sel) return;
  const date = dateStr || document.getElementById('inv-return-date').value || new Date().toISOString().split('T')[0];
  sel.innerHTML = '<option value="">✈ Loading flights…</option>';
  try {
    const res  = await fetch(`/api/flights/arrivals?date=${date}`);
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const day  = days[data.dayOfWeek] || '';
    const liveTag = data.live ? ' (live)' : '';
    sel.innerHTML = `<option value="">✈ ${day} flights – Bay of Islands${liveTag}</option>`;
    (data.flights || []).forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.time;
      const status = f.status && f.status !== 'scheduled' && f.status !== 'on-time' ? ` ⚠ ${f.status}` : '';
      opt.textContent = `${f.label || f.time}  ${f.flight}${status}`;
      sel.appendChild(opt);
    });
  } catch (_) {
    sel.innerHTML = '<option value="">✈ Flights unavailable</option>';
  }
}

document.getElementById('inv-flight-arrival-select').addEventListener('change', (e) => {
  if (e.target.value) {
    const tbc = document.getElementById('inv-return-time-tbc');
    if (tbc) tbc.checked = false;
    document.getElementById('inv-return-date').disabled = false;
    document.getElementById('inv-return-time').disabled = false;
    if (!document.getElementById('inv-return-date').value) {
      const dateIn = document.getElementById('inv-date-in').value || localDateStr(new Date());
      document.getElementById('inv-return-date').value = addDays(dateIn, 1);
    }
    document.getElementById('inv-return-time').value = e.target.value;
    e.target.value = '';
  }
});

async function newInvoice() {
  clearOnAccountPaymentLock();
  setPricingModeLabel('manual');
  // Must succeed before we clear — otherwise the screen looks unchanged (same V#) and users think the button is broken.
  const res = await fetch('/api/invoices/next-number');
  if (!res.ok) {
    showAlert('Could not get the next invoice number. Check your connection and try again.', 'danger');
    return;
  }
  const data = await res.json();
  document.getElementById('inv-number-display').textContent = data.invoiceNumber;

  // Clear form
  currentInvoiceId = null;
  existingCreditApplied = 0;
  newlyStagedCredit = 0;
  availableCreditInfo = null;
  document.getElementById('credit-display').innerHTML = 'N/A';
  document.getElementById('amount-due-hint').classList.add('d-none');
  document.getElementById('inv-id').value = '';
  document.getElementById('inv-customer-id').value = '';
  document.getElementById('inv-rego').value = '';
  document.getElementById('inv-last-name').value = '';
  document.getElementById('inv-first-name').value = '';
  document.getElementById('inv-phone').value = '';
  document.getElementById('inv-email').value = '';
  document.getElementById('inv-notes').value = '';
  document.getElementById('inv-flight-info').value = '';
  document.getElementById('inv-total-price').value = '';
  document.getElementById('inv-payment-amount').value = '';
  document.getElementById('inv-payment-amount-2').value = '';
  document.getElementById('inv-paid-status').value = 'To Pay';
  document.getElementById('inv-paid-status-2').value = '';
  document.getElementById('inv-payment-date-1').value = '';
  document.getElementById('inv-payment-date-2').value = '';
  syncPaymentReceivedDateUi();
  document.getElementById('inv-do-not-move').checked = false;
  document.getElementById('inv-picked-up').value = 'Car In Yard';
  document.getElementById('inv-discount-10').checked = false;
  document.getElementById('inv-account-customer').value = '';
  document.getElementById('price-breakdown').textContent = '';
  // Clear any existing customer alert (if the alert elements exist)
  setCustomerAlertText('');

  // Set default dates using local time (not UTC) so NZ timezone is correct
  const now = new Date();
  document.getElementById('inv-date-in').value = localDateStr(now);
  document.getElementById('inv-time-in').value = now.toTimeString().substr(0, 5);
  // Default return: tomorrow
  document.getElementById('inv-return-date').value = addDays(localDateStr(now), 1);
  document.getElementById('inv-return-time').value = '14:35';
  document.getElementById('inv-return-time-tbc').checked = false;
  document.getElementById('inv-return-date').disabled = false;
  document.getElementById('inv-return-time').disabled = false;

  updateNightsAndDisplay();
  document.getElementById('inv-status-badge').innerHTML = `<span class="badge bg-warning text-dark">UNSAVED</span>`;
  const _sbt = document.getElementById('save-btn-text');
  if (_sbt) _sbt.textContent = 'SAVE INVOICE';
  document.getElementById('btn-print-receipt').disabled = true;
  document.getElementById('btn-email-receipt').disabled = true;
  document.getElementById('btn-void-invoice').disabled = true;
  document.getElementById('btn-refund').disabled = true;
  document.getElementById('btn-delete-invoice').disabled = true;
}

async function loadInvoice(invoiceNumber, invoiceId) {
  clearOnAccountPaymentLock();
  let url = invoiceId ? `/api/invoices/${invoiceId}` : `/api/invoices?search=${invoiceNumber}`;
  const res = await fetch(url);
  if (!res.ok) { showAlert('Invoice not found', 'danger'); return; }
  
  let inv;
  if (invoiceId) {
    inv = await res.json();
  } else {
    const list = await res.json();
    inv = list.find(i => i.invoice_number == invoiceNumber);
    if (!inv) { showAlert('Invoice not found', 'danger'); return; }
  }

  currentInvoiceId = inv.id;
  document.getElementById('inv-id').value = inv.id;
  document.getElementById('inv-number-display').textContent = inv.invoice_number;
  document.getElementById('inv-customer-id').value = inv.customer_id || '';
  document.getElementById('inv-rego').value = inv.rego || '';
  document.getElementById('inv-last-name').value = inv.last_name || '';
  document.getElementById('inv-first-name').value = inv.first_name || '';
  document.getElementById('inv-phone').value = inv.phone || '';
  document.getElementById('inv-email').value = inv.email || '';
  document.getElementById('inv-notes').value = inv.notes || '';
  document.getElementById('inv-flight-info').value = inv.flight_info || '';
  document.getElementById('inv-flight-type').value = inv.flight_type || 'Standard - On Flight';
  document.getElementById('inv-total-price').value = inv.total_price || '';
  existingCreditApplied = parseFloat(inv.credit_applied) || 0;
  newlyStagedCredit = 0;
  if (existingCreditApplied > 0) {
    document.getElementById('credit-display').innerHTML = `<span class="text-success">$${existingCreditApplied.toFixed(2)} applied</span>`;
  }
  updateAmountDueHint();
  document.getElementById('inv-payment-amount').value = inv.payment_amount || '';
  document.getElementById('inv-paid-status').value = inv.paid_status || 'To Pay';
  document.getElementById('inv-payment-amount-2').value = inv.payment_amount_2 || '';
  document.getElementById('inv-paid-status-2').value = inv.paid_status_2 || '';
  document.getElementById('inv-payment-date-1').value = inv.payment_date_1 ? String(inv.payment_date_1).slice(0, 10) : '';
  document.getElementById('inv-payment-date-2').value = inv.payment_date_2 ? String(inv.payment_date_2).slice(0, 10) : '';
  syncPaymentReceivedDateUi();
  document.getElementById('inv-do-not-move').checked = !!inv.do_not_move;
  document.getElementById('inv-picked-up').value = inv.picked_up || 'Car In Yard';
  document.getElementById('inv-account-customer').value = inv.account_customer_id || '';
  document.getElementById('inv-discount-10').checked = inv.discount_percent == 10;

  if (inv.date_in) document.getElementById('inv-date-in').value = inv.date_in.split('T')[0];
  if (inv.time_in) document.getElementById('inv-time-in').value = inv.time_in;
  if (inv.return_date) document.getElementById('inv-return-date').value = inv.return_date.split('T')[0];
  if (inv.return_date && inv.return_time) {
    document.getElementById('inv-return-time').value = inv.return_time;
    document.getElementById('inv-return-time-tbc').checked = false;
    document.getElementById('inv-return-date').disabled = false;
    document.getElementById('inv-return-time').disabled = false;
  } else {
    document.getElementById('inv-return-date').value = '';
    document.getElementById('inv-return-time').value = '';
    document.getElementById('inv-return-time-tbc').checked = true;
    document.getElementById('inv-return-date').disabled = true;
    document.getElementById('inv-return-time').disabled = true;
  }

  // Key
  if (inv.no_key) {
    document.getElementById('inv-no-key').checked = true;
    document.getElementById('inv-key-number').value = '';
  } else if (inv.key_number) {
    // Add key to select if not present
    const keySel = document.getElementById('inv-key-number');
    let found = Array.from(keySel.options).find(o => o.value == inv.key_number);
    if (!found) {
      const opt = document.createElement('option');
      opt.value = inv.key_number;
      opt.textContent = `Key ${inv.key_number}`;
      keySel.appendChild(opt);
    }
    keySel.value = inv.key_number;
  }

  // Split payment
  if (inv.payment_amount_2 > 0 || inv.paid_status_2) {
    document.getElementById('split-payment-toggle').checked = true;
    document.getElementById('payment2-section').classList.remove('d-none');
  }

  // Customer alert
  if (inv.customer_alert) {
    setCustomerAlertText(inv.customer_alert);
  }

  if ((inv.account_customer_id || inv.paid_status === 'OnAcc') && !inv.void) {
    // If OnAcc but no linked account customer, treat as LT-style locked pricing.
    setLongTermPricingMode(!inv.account_customer_id && inv.paid_status === 'OnAcc');
    setPricingModeLabel(inv.account_customer_id ? 'account-rate-card' : 'longterm');
    setOnAccountPaymentLock(inv.account_customer_id ? 'On Account' : 'Long Term', true);
  } else {
    setPricingModeLabel('manual');
  }

  updateNightsAndDisplay();
  document.getElementById('inv-status-badge').innerHTML = inv.void
    ? `<span class="badge bg-secondary">VOIDED</span>`
    : `<span class="badge bg-success">SAVED</span>`;
  const _sbt2 = document.getElementById('save-btn-text');
  if (_sbt2) _sbt2.textContent = 'UPDATE INVOICE';
  document.getElementById('btn-print-receipt').disabled = false;
  document.getElementById('btn-email-receipt').disabled = false;
  document.getElementById('btn-void-invoice').disabled = !!inv.void;
  document.getElementById('btn-refund').disabled = false;
  document.getElementById('btn-delete-invoice').disabled = false;
}

function updateNightsAndDisplay() {
  const dateIn = document.getElementById('inv-date-in').value;
  const returnDate = document.getElementById('inv-return-date').value;
  const timeIn = document.getElementById('inv-time-in').value;
  const returnTimeEl = document.getElementById('inv-return-time');
  const returnTime = returnTimeEl ? returnTimeEl.value : '';
  const nights = calcNights24h(dateIn, timeIn, returnDate, returnTime);
  document.getElementById('inv-nights').value = nights;
  document.getElementById('date-in-display').textContent = dateIn ? formatDate(dateIn) : 'Not set';
  document.getElementById('time-in-display').textContent = timeIn || '--:--';
}

function setPricingModeLabel(mode) {
  pricingMode = mode || 'manual';
  const el = document.getElementById('pricing-mode-label');
  if (!el) return;
  if (pricingMode === 'longterm') {
    el.innerHTML = '<span class="badge bg-warning text-dark">Mode: Long Term Auto</span>';
    return;
  }
  if (pricingMode === 'account-rate-card') {
    el.innerHTML = '<span class="badge bg-info text-dark">Mode: Account Rate Card</span>';
    return;
  }
  if (pricingMode === 'account-discount') {
    el.innerHTML = '<span class="badge bg-primary">Mode: Account Discount Pricing</span>';
    return;
  }
  el.innerHTML = '<span class="badge bg-secondary-subtle text-secondary-emphasis">Mode: Manual / Short-stay</span>';
}

function setLongTermPricingMode(active) {
  longTermPricingActive = !!active;
  const calcBtn = document.getElementById('btn-calculate');
  if (!calcBtn) return;
  calcBtn.disabled = longTermPricingActive;
  calcBtn.title = longTermPricingActive
    ? 'Long-term booking detected: price auto-filled from long-term settings'
    : '';
  if (longTermPricingActive) setPricingModeLabel('longterm');
  else if (pricingMode === 'longterm') setPricingModeLabel('manual');
}

function syncReturnDateFromNights() {
  if (document.getElementById('inv-return-time-tbc').checked) return;
  const dateIn = document.getElementById('inv-date-in').value;
  if (!dateIn) return;
  const nights = Math.max(0, parseInt(document.getElementById('inv-nights').value, 10) || 0);
  document.getElementById('inv-return-date').value = addDays(dateIn, nights);
  updateNightsAndDisplay();
  loadFlightsForDate(document.getElementById('inv-return-date').value);
}

function setOnAccountPaymentLock(reasonLabel, silent) {
  paymentLockReason = reasonLabel || 'On Account';
  const paidStatus = document.getElementById('inv-paid-status');
  const splitToggle = document.getElementById('split-payment-toggle');
  const paidStatus2 = document.getElementById('inv-paid-status-2');
  const payment2 = document.getElementById('inv-payment-amount-2');

  const total = parseFloat(document.getElementById('inv-total-price').value) || 0;
  paidStatus.value = 'OnAcc';
  paidStatus.disabled = true; // hard lock: no Eftpos/Cash while detected
  document.getElementById('inv-payment-amount').value = total > 0 ? total.toFixed(2) : '';
  // Single on-account line by default.
  splitToggle.checked = false;
  splitToggle.disabled = true;
  document.getElementById('payment2-section').classList.add('d-none');
  paidStatus2.value = '';
  paidStatus2.disabled = true;
  payment2.value = '';
  payment2.disabled = true;
  if (reasonLabel && !silent) showAlert(`Payment auto-set to On Account (${reasonLabel})`, 'info');
}

function clearOnAccountPaymentLock() {
  paymentLockReason = '';
  setLongTermPricingMode(false);
  const paidStatus = document.getElementById('inv-paid-status');
  const splitToggle = document.getElementById('split-payment-toggle');
  const paidStatus2 = document.getElementById('inv-paid-status-2');
  const payment2 = document.getElementById('inv-payment-amount-2');
  paidStatus.disabled = false;
  splitToggle.disabled = false;
  paidStatus2.disabled = false;
  payment2.disabled = false;
}

function splitNameFromFull(full) {
  const s = (full || '').trim();
  if (!s) return { first: '', last: '' };
  if (s.includes(',')) {
    const parts = s.split(',').map(x => x.trim());
    return { last: parts[0] || '', first: parts.slice(1).join(' ') || '' };
  }
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { first: '', last: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/**
 * Decide which amount to use for a long-term invoice preview.
 * Priority:
 * 1) explicit LT rate (normal case)
 * 2) contract_amount fallback (prevents confusing $0.00 when rate is missing)
 */
function getLongTermInvoiceAmount(lt) {
  const GST_RATE = 0.15;
  const rate = parseFloat(lt.rate);
  if (Number.isFinite(rate) && rate > 0) {
    const base = rate;
    const gst = base * GST_RATE;
    return { amount: base + gst, base, gst, source: 'rate' };
  }
  const contract = parseFloat(lt.contract_amount);
  if (Number.isFinite(contract) && contract > 0) {
    const base = contract;
    const gst = base * GST_RATE;
    return { amount: base + gst, base, gst, source: 'contract' };
  }
  return { amount: 0, base: 0, gst: 0, source: 'none' };
}

/** When rego matches a long-term record: fill customer + amount + on-account lock. */
function applyLongTermToInvoice(lt) {
  const { first, last } = splitNameFromFull(lt.name);
  document.getElementById('inv-first-name').value = first;
  document.getElementById('inv-last-name').value = last;
  if (lt.phone) document.getElementById('inv-phone').value = lt.phone;
  if (lt.email) document.getElementById('inv-email').value = lt.email;
  const selected = getLongTermInvoiceAmount(lt);
  document.getElementById('inv-total-price').value = selected.amount.toFixed(2);
  document.getElementById('inv-payment-amount').value = selected.amount.toFixed(2);
  let breakdown = `Long-term ${lt.lt_number}: ex GST $${selected.base.toFixed(2)} + GST $${selected.gst.toFixed(2)} = $${selected.amount.toFixed(2)}`;
  if (lt.contract_amount != null && lt.contract_amount !== '') {
    breakdown += ` (term base $${parseFloat(lt.contract_amount).toFixed(2)})`;
  }
  if (selected.source === 'contract') {
    breakdown += ' (using term total fallback: LT rate missing)';
  }
  document.getElementById('price-breakdown').textContent = breakdown;
  document.getElementById('inv-account-customer').value = '';
  setPricingModeLabel('longterm');
  setLongTermPricingMode(true);
  setOnAccountPaymentLock('Long Term', true);
}

// ─── Rego / email lookup: previous invoice + long-term + on-account detection ─
/** Apply fields from the most recent invoice for this rego (API merges customer master when invoice snapshot is thin). */
function applyInvoiceFromPreviousVisit(inv, options = {}) {
  if (!inv) return;
  const mergeOnlyMissing = !!options.mergeOnlyMissing;
  const skipAccount = !!options.skipAccount;
  const setField = (id, val) => {
    if (val == null || val === '') return;
    const el = document.getElementById(id);
    if (!el) return;
    if (mergeOnlyMissing && String(el.value || '').trim() !== '') return;
    el.value = val;
  };
  setField('inv-last-name', inv.last_name);
  setField('inv-first-name', inv.first_name);
  setField('inv-phone', inv.phone);
  setField('inv-email', inv.email);
  if (inv.flight_info != null && String(inv.flight_info).trim() !== '') {
    const el = document.getElementById('inv-flight-info');
    if (el && (!mergeOnlyMissing || !String(el.value || '').trim())) el.value = inv.flight_info;
  }
  if (inv.flight_type) {
    const el = document.getElementById('inv-flight-type');
    if (el && (!mergeOnlyMissing || !String(el.value || '').trim())) el.value = inv.flight_type;
  }
  if (inv.notes != null && String(inv.notes).trim() !== '') {
    const el = document.getElementById('inv-notes');
    if (el && (!mergeOnlyMissing || !String(el.value || '').trim())) el.value = inv.notes;
  }
  if (inv.customer_id) {
    document.getElementById('inv-customer-id').value = inv.customer_id;
  }
  const alertText = inv.customer_alert || inv.customer_alert_stored;
  if (alertText) setCustomerAlertText(alertText);
  if (!skipAccount && inv.account_customer_id) {
    document.getElementById('inv-account-customer').value = String(inv.account_customer_id);
    const acct = accountCustomers.find(a => String(a.id) === String(inv.account_customer_id));
    if (acct) applyAccountCustomerPricingFromLookup(acct);
    else setOnAccountPaymentLock('On Account', true);
  }
}

function applyAccountCustomerPricingFromLookup(acct) {
  if (!acct) return;
  const billing = (acct.billing_email || acct.email || '').trim();
  if (billing) document.getElementById('inv-email').value = billing;
  const d = acct.discount_percent || 0;
  showAlert(`On-account customer: ${escapeHtml(acct.company_name)}${d > 0 ? ` (${d}% discount on short-term rates)` : ''}`, 'info');
  const nights = parseInt(document.getElementById('inv-nights').value, 10) || 1;
  fetch(`/api/invoices/calculate-price?nights=${nights}&account_customer_id=${acct.id}`)
    .then(r => r.json())
    .then(p => {
      if (!p || p.error) return;
      document.getElementById('inv-total-price').value = p.total.toFixed(2);
      document.getElementById('inv-payment-amount').value = p.total.toFixed(2);
      document.getElementById('price-breakdown').textContent =
        `${nights} day(s) × $${p.dailyRate}/day = $${(p.dailyRate * nights).toFixed(2)}` +
        (p.pricing_mode === 'account_rate_card'
          ? ' (account rate card)'
          : (p.discountPercent > 0 ? ` (${p.discountPercent}% account discount → $${p.total.toFixed(2)})` : ''));
      setPricingModeLabel(p.pricing_mode === 'account_rate_card'
        ? 'account-rate-card'
        : (p.discountPercent > 0 ? 'account-discount' : 'manual'));
      setLongTermPricingMode(false);
      setOnAccountPaymentLock('On Account', true);
    })
    .catch(() => {});
}

async function runCustomerLookup() {
  const rego = document.getElementById('inv-rego').value.trim();
  if (currentInvoiceId) return;
  if (!rego) {
    if (!document.getElementById('inv-account-customer').value) clearOnAccountPaymentLock();
    return;
  }
  const email = (document.getElementById('inv-email') && document.getElementById('inv-email').value) || '';
  const res = await fetch(`/api/invoices/lookup-rego?rego=${encodeURIComponent(rego)}&email=${encodeURIComponent(email)}`);
  if (!res.ok) return;
  const data = await res.json();
  const inv = data.invoice;

  if (data.longterm) {
    const lt = data.longterm;
    applyLongTermToInvoice(lt);
    if (inv) {
      applyInvoiceFromPreviousVisit(inv, { mergeOnlyMissing: true, skipAccount: true });
    }
    const rp = lt.rate_period || 'monthly';
    const selected = getLongTermInvoiceAmount(lt);
    const msg = selected.source === 'contract'
      ? `Long-term match (${lt.lt_number} — ${escapeHtml(lt.name)}). LT rate is missing, term fallback used: ex GST $${selected.base.toFixed(2)} + GST = $${selected.amount.toFixed(2)} (${rp}).`
      : `Long-term match (${lt.lt_number} — ${escapeHtml(lt.name)}). Amount with GST: $${selected.amount.toFixed(2)} (ex GST $${selected.base.toFixed(2)}, ${rp}).`;
    showAlert(msg, 'warning');
    return;
  }

  if (inv) {
    applyInvoiceFromPreviousVisit(inv, { mergeOnlyMissing: false, skipAccount: false });
    showAlert(`✓ Details auto-filled from previous visit (Invoice #${inv.invoice_number})`, 'info');
  }

  if (data.accountCustomer && !document.getElementById('inv-account-customer').value) {
    document.getElementById('inv-account-customer').value = data.accountCustomer.id;
    applyAccountCustomerPricingFromLookup(data.accountCustomer);
  } else if (!data.accountCustomer && !document.getElementById('inv-account-customer').value) {
    clearOnAccountPaymentLock();
  }
}

document.getElementById('inv-rego').addEventListener('blur', () => { runCustomerLookup(); });

// ─── Customer credit lookup (early-return refunds) ─────────────────────────
// Only runs for NEW bookings — once an invoice is saved, its credit_applied
// is fixed to what was staged at save time (see save() below); re-running
// this against an existing invoice risks double-counting an already-applied
// credit against its own source ledger entry.
async function checkCustomerCredit() {
  if (currentInvoiceId) return;
  const phone = document.getElementById('inv-phone').value.trim();
  const firstName = document.getElementById('inv-first-name').value.trim();
  const lastName = document.getElementById('inv-last-name').value.trim();
  if (!phone && !(firstName && lastName)) {
    renderCreditDisplay(null);
    return;
  }
  try {
    const qs = new URLSearchParams();
    if (phone) qs.set('phone', phone);
    if (firstName) qs.set('first_name', firstName);
    if (lastName) qs.set('last_name', lastName);
    const res = await fetch(`/api/invoices/credits/lookup?${qs.toString()}`);
    if (!res.ok) return;
    availableCreditInfo = await res.json();
    renderCreditDisplay(availableCreditInfo);
  } catch (e) { /* credit lookup is a convenience, not a blocking part of booking */ }
}

function updateAmountDueHint() {
  const hint = document.getElementById('amount-due-hint');
  if (!hint) return;
  const total = parseFloat(document.getElementById('inv-total-price').value) || 0;
  const creditNow = existingCreditApplied + newlyStagedCredit;
  if (creditNow <= 0 || total <= 0) {
    hint.classList.add('d-none');
    return;
  }
  const due = Math.max(0, Math.round((total - creditNow) * 100) / 100);
  hint.classList.remove('d-none');
  hint.textContent = `Amount due: $${due.toFixed(2)} (after $${creditNow.toFixed(2)} credit)`;
}

function renderCreditDisplay(data) {
  const el = document.getElementById('credit-display');
  if (newlyStagedCredit > 0) return; // don't clobber a credit the user just applied
  if (!data || !data.totalAvailable || data.totalAvailable <= 0) {
    el.innerHTML = 'N/A';
    return;
  }
  el.innerHTML = `<span class="text-success">$${data.totalAvailable.toFixed(2)} available</span> ` +
    `<button type="button" class="btn btn-sm btn-outline-success ms-1" id="btn-apply-credit">Apply</button>`;
  const btn = document.getElementById('btn-apply-credit');
  if (btn) btn.addEventListener('click', applyAvailableCredit);
}

function applyAvailableCredit() {
  if (!availableCreditInfo || !availableCreditInfo.totalAvailable) return;
  const total = parseFloat(document.getElementById('inv-total-price').value) || 0;
  if (total <= 0) { showAlert('Enter a total price before applying credit', 'warning'); return; }
  const toApply = Math.round(Math.min(availableCreditInfo.totalAvailable, total) * 100) / 100;
  if (toApply <= 0) return;
  newlyStagedCredit = toApply;

  // Record the credit as the payment method for the portion it covers —
  // "Customer Credit" is a real, distinct payment status (counted as
  // revenue, but excluded from Eftpos/Cash/Banking reconciliation, since
  // no new physical money changes hands today).
  document.getElementById('inv-paid-status').value = 'Customer Credit';
  document.getElementById('inv-payment-amount').value = toApply.toFixed(2);
  syncPaymentReceivedDateUi();

  const remainder = Math.round((total - toApply) * 100) / 100;
  if (remainder > 0.01) {
    // Credit only covers part of the booking — open the 2nd payment slot
    // for staff to record how the remaining balance was actually paid.
    document.getElementById('split-payment-toggle').checked = true;
    document.getElementById('payment2-section').classList.remove('d-none');
    document.getElementById('inv-payment-amount-2').value = remainder.toFixed(2);
    showAlert(`$${toApply.toFixed(2)} credit applied. $${remainder.toFixed(2)} remains — pick a payment method for the 2nd payment below.`, 'info');
  } else {
    showAlert(`$${toApply.toFixed(2)} credit fully covers this booking.`, 'success');
  }

  const el = document.getElementById('credit-display');
  el.innerHTML = `<span class="text-success">$${toApply.toFixed(2)} credit will be applied</span> ` +
    `<button type="button" class="btn btn-sm btn-outline-secondary ms-1" id="btn-undo-credit">Undo</button>`;
  document.getElementById('btn-undo-credit').addEventListener('click', () => {
    newlyStagedCredit = 0;
    if (document.getElementById('inv-paid-status').value === 'Customer Credit') {
      document.getElementById('inv-paid-status').value = 'To Pay';
      document.getElementById('inv-payment-amount').value = '';
      syncPaymentReceivedDateUi();
    }
    renderCreditDisplay(availableCreditInfo);
    updateAmountDueHint();
  });
  updateAmountDueHint();
}

document.getElementById('inv-phone').addEventListener('blur', checkCustomerCredit);
document.getElementById('inv-last-name').addEventListener('blur', checkCustomerCredit);
document.getElementById('inv-total-price').addEventListener('input', updateAmountDueHint);
document.getElementById('inv-total-price').addEventListener('change', updateAmountDueHint);

document.getElementById('inv-email').addEventListener('blur', () => {
  if (currentInvoiceId) return;
  runCustomerLookup();
});

// Also trigger lookup on Enter key in rego field
document.getElementById('inv-rego').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('inv-rego').blur(); }
});

document.getElementById('inv-account-customer').addEventListener('change', () => {
  if (currentInvoiceId) return;
  if (!document.getElementById('inv-account-customer').value) {
    setPricingModeLabel('manual');
    clearOnAccountPaymentLock();
    return;
  }
  const id = document.getElementById('inv-account-customer').value;
  const acct = accountCustomers.find(a => String(a.id) === String(id));
  if (acct) {
    const billing = (acct.billing_email || acct.email || '').trim();
    if (billing) document.getElementById('inv-email').value = billing;
  }
  setPricingModeLabel('account-rate-card');
  setOnAccountPaymentLock('On Account', true);
});

// ─── Event listeners ──────────────────────────────────────────────────────────
document.getElementById('inv-date-in').addEventListener('change', updateNightsAndDisplay);
document.getElementById('inv-date-in').addEventListener('input', updateNightsAndDisplay);
document.getElementById('inv-nights').addEventListener('change', syncReturnDateFromNights);
document.getElementById('inv-nights').addEventListener('blur', syncReturnDateFromNights);
document.getElementById('inv-return-date').addEventListener('change', () => {
  updateNightsAndDisplay();
  loadFlightsForDate(document.getElementById('inv-return-date').value);
});
document.getElementById('inv-return-date').addEventListener('input', () => {
  updateNightsAndDisplay();
  loadFlightsForDate(document.getElementById('inv-return-date').value);
});
document.getElementById('inv-time-in').addEventListener('change', updateNightsAndDisplay);
document.getElementById('inv-time-in').addEventListener('input', updateNightsAndDisplay);
document.getElementById('inv-return-time').addEventListener('change', updateNightsAndDisplay);
document.getElementById('inv-return-time').addEventListener('input', updateNightsAndDisplay);
document.getElementById('inv-return-time-tbc').addEventListener('change', (e) => {
  const d = document.getElementById('inv-return-date');
  const t = document.getElementById('inv-return-time');
  d.disabled = e.target.checked;
  t.disabled = e.target.checked;
  if (e.target.checked) {
    d.value = '';
    t.value = '';
  } else {
    if (!d.value) {
      const dateIn = document.getElementById('inv-date-in').value || localDateStr(new Date());
      d.value = addDays(dateIn, 1);
    }
    if (!t.value) t.value = '14:35';
  }
  updateNightsAndDisplay();
  loadFlightsForDate(d.value);
});

document.getElementById('btn-prev-date').addEventListener('click', () => {
  const cur = document.getElementById('inv-return-date').value || today();
  document.getElementById('inv-return-date').value = addDays(cur, -1);
  updateNightsAndDisplay();
  loadFlightsForDate(document.getElementById('inv-return-date').value);
});

document.getElementById('btn-next-date').addEventListener('click', () => {
  const cur = document.getElementById('inv-return-date').value || today();
  document.getElementById('inv-return-date').value = addDays(cur, 1);
  updateNightsAndDisplay();
  loadFlightsForDate(document.getElementById('inv-return-date').value);
});

document.getElementById('split-payment-toggle').addEventListener('change', (e) => {
  if (paymentLockReason) {
    e.target.checked = false;
    document.getElementById('payment2-section').classList.add('d-none');
    return;
  }
  document.getElementById('payment2-section').classList.toggle('d-none', !e.target.checked);
  syncPaymentReceivedDateUi();
  ensurePaymentDateDefaults();
});

document.getElementById('inv-no-key').addEventListener('change', (e) => {
  document.getElementById('inv-key-number').disabled = e.target.checked;
  if (e.target.checked) document.getElementById('inv-key-number').value = '';
});

// ─── 10% Discount: auto-recalculate when toggled (if price already calculated) ─
document.getElementById('inv-discount-10').addEventListener('change', () => {
  const total = parseFloat(document.getElementById('inv-total-price').value);
  if (!total || total === 0) return; // Nothing to recalculate yet

  const breakdown = document.getElementById('price-breakdown').textContent;
  // Extract base price from breakdown (recalculate via button or apply/remove discount directly)
  const isChecked = document.getElementById('inv-discount-10').checked;

  // Re-fetch a clean calculate if we have the nights value
  const nights = parseInt(document.getElementById('inv-nights').value) || 1;
  const accountId = document.getElementById('inv-account-customer').value;
  fetch(`/api/invoices/calculate-price?nights=${nights}&account_customer_id=${accountId}`)
    .then(r => r.json())
    .then(data => {
      let newTotal = data.total;
      if (isChecked) newTotal = newTotal * 0.9;
      document.getElementById('inv-total-price').value = newTotal.toFixed(2);
      document.getElementById('inv-payment-amount').value = newTotal.toFixed(2);
      let b = `${nights} day(s) × $${data.dailyRate}/day = $${data.total.toFixed(2)}`;
      if (data.pricing_mode === 'account_rate_card') b += ' (account rate card)';
      else if (data.discountPercent > 0) b += ` (${data.discountPercent}% account discount)`;
      if (isChecked) b += ` → -10% = $${newTotal.toFixed(2)}`;
      document.getElementById('price-breakdown').textContent = b;
    });
});

// ─── Auto-release key when vehicle is collected ───────────────────────────────
document.getElementById('inv-picked-up').addEventListener('change', async (e) => {
  const status = e.target.value;
  if (status !== 'Picked Up' && status !== 'Delivered') return;
  if (!currentInvoiceId) return; // Not saved yet

  const keyNum = document.getElementById('inv-key-number').value;
  if (!keyNum || document.getElementById('inv-no-key').checked) return;

  // Release the key automatically
  try {
    await fetch(`/api/keybox/${keyNum}/release`, { method: 'POST' });
    showAlert(`Key ${keyNum} released — slot now available`, 'success');
  } catch (err) {
    console.warn('Key release failed:', err);
  }
});

// Auto-fill payment when status selected
document.getElementById('inv-paid-status').addEventListener('change', () => {
  const total = parseFloat(document.getElementById('inv-total-price').value) || 0;
  const p2 = parseFloat(document.getElementById('inv-payment-amount-2').value) || 0;
  if (total > 0 && !document.getElementById('inv-payment-amount').value) {
    document.getElementById('inv-payment-amount').value = (total - p2).toFixed(2);
  }
  const s = document.getElementById('inv-paid-status').value;
  if (!s || s === 'To Pay') document.getElementById('inv-payment-date-1').value = '';
  syncPaymentReceivedDateUi();
  ensurePaymentDateDefaults();
});

document.getElementById('inv-paid-status-2').addEventListener('change', () => {
  const s = document.getElementById('inv-paid-status-2').value;
  if (!s || s === 'To Pay') document.getElementById('inv-payment-date-2').value = '';
  syncPaymentReceivedDateUi();
  ensurePaymentDateDefaults();
});

// Calculate price
document.getElementById('btn-calculate').addEventListener('click', async () => {
  if (longTermPricingActive) {
    showAlert('Long-term booking detected: price is auto-filled from Long Term settings.', 'info');
    return;
  }
  const nights = parseInt(document.getElementById('inv-nights').value) || 1;
  const accountId = document.getElementById('inv-account-customer').value;
  const res = await fetch(`/api/invoices/calculate-price?nights=${nights}&account_customer_id=${accountId}`);
  if (!res.ok) return;
  const data = await res.json();

  let total = data.total;
  if (document.getElementById('inv-discount-10').checked) {
    total = total * 0.9;
  }

  document.getElementById('inv-total-price').value = total.toFixed(2);
  document.getElementById('inv-payment-amount').value = total.toFixed(2);
  let breakdown = `${nights} day(s) × $${data.dailyRate}/day = $${data.total.toFixed(2)}`;
  if (data.pricing_mode === 'account_rate_card') breakdown += ' (account rate card)';
  else if (data.discountPercent > 0) breakdown += ` (${data.discountPercent}% account discount applied)`;
  if (document.getElementById('inv-discount-10').checked) breakdown += ` (-10% discount)`;
  document.getElementById('price-breakdown').textContent = breakdown;
  setPricingModeLabel(data.pricing_mode === 'account_rate_card'
    ? 'account-rate-card'
    : (data.discountPercent > 0 ? 'account-discount' : 'manual'));
});

// Search customer
document.getElementById('btn-search-customer').addEventListener('click', async () => {
  const search = document.getElementById('customer-search').value.trim();
  if (!search) return;
  const res = await fetch(`/api/customers?search=${encodeURIComponent(search)}`);
  if (!res.ok) return;
  const customers = await res.json();

  const container = document.getElementById('customer-search-results');
  if (customers.length === 0) {
    container.innerHTML = '<div class="alert alert-info small py-2">No customers found. Fill in the form to create a new customer.</div>';
    return;
  }

  container.innerHTML = `
    <div class="table-responsive">
      <table class="table table-sm table-hover border">
        <thead><tr><th>Name</th><th>Phone</th><th>Rego</th><th></th></tr></thead>
        <tbody>
          ${customers.map(c => `
            <tr>
              <td>${escapeHtml(c.last_name || '')}, ${escapeHtml(c.first_name || '')}</td>
              <td>${escapeHtml(c.phone || '')}</td>
              <td>${escapeHtml(c.email || '')}</td>
              <td><button class="btn btn-sm btn-primary select-customer" data-id="${c.id}" 
                  data-firstname="${escapeHtml(c.first_name||'')}" data-lastname="${escapeHtml(c.last_name||'')}"
                  data-phone="${escapeHtml(c.phone||'')}" data-email="${escapeHtml(c.email||'')}"
                  data-alert="${escapeHtml(c.alert_message||'')}">Select</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  container.querySelectorAll('.select-customer').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('inv-customer-id').value = btn.dataset.id;
      document.getElementById('inv-first-name').value = btn.dataset.firstname;
      document.getElementById('inv-last-name').value = btn.dataset.lastname;
      document.getElementById('inv-phone').value = btn.dataset.phone;
      document.getElementById('inv-email').value = btn.dataset.email;
      if (btn.dataset.alert) {
        setCustomerAlertText(btn.dataset.alert);
      }
      container.innerHTML = '';
      document.getElementById('customer-search').value = '';
    });
  });
});

document.getElementById('btn-search-invoice').addEventListener('click', async () => {
  const invNo = parseInt(document.getElementById('invoice-search-number').value, 10);
  if (!invNo) { showAlert('Enter an invoice number', 'warning'); return; }
  await loadInvoice(invNo, null);
});
document.getElementById('invoice-search-number').addEventListener('keypress', async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  document.getElementById('btn-search-invoice').click();
});

document.getElementById('customer-search').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-search-customer').click();
});

// New invoice button
document.getElementById('btn-new-invoice').addEventListener('click', (e) => {
  e.preventDefault();
  const btn = document.getElementById('btn-new-invoice');
  if (btn.disabled) return;
  const noKey = document.getElementById('inv-no-key').checked;
  const prevKey = noKey ? '' : (document.getElementById('inv-key-number').value || '');
  try {
    sessionStorage.setItem(KEY_AVOID_SESSION_KEY, prevKey);
  } catch (_) {}
  const w = window.open('/invoice.html', '_blank');
  if (w) w.opener = null;
  else showAlert('Popup blocked — allow popups for this site to open a new invoice in a new tab.', 'warning');
});

// Customer alert modal
document.getElementById('btn-customer-alert').addEventListener('click', () => {
  document.getElementById('modal-alert-text').value = getCustomerAlertText() || '';
  new bootstrap.Modal('#alertModal').show();
});

document.getElementById('btn-save-alert').addEventListener('click', () => {
  const alertText = document.getElementById('modal-alert-text').value.trim();
  setCustomerAlertText(alertText);
  bootstrap.Modal.getInstance('#alertModal').hide();
});

// Save invoice form
document.getElementById('invoiceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (_saving) return; // prevent double-submit / race condition

  const invNum = document.getElementById('inv-number-display').textContent;
  if (!invNum || invNum === 'NEW') {
    showAlert('Invoice number not set', 'danger');
    return;
  }

  const payload = {
    invoice_number: invNum,
    customer_id: document.getElementById('inv-customer-id').value || null,
    account_customer_id: document.getElementById('inv-account-customer').value || null,
    key_number: document.getElementById('inv-no-key').checked ? null : (document.getElementById('inv-key-number').value || null),
    no_key: document.getElementById('inv-no-key').checked,
    rego: document.getElementById('inv-rego').value,
    first_name: document.getElementById('inv-first-name').value,
    last_name: document.getElementById('inv-last-name').value,
    phone: document.getElementById('inv-phone').value,
    email: document.getElementById('inv-email').value,
    date_in: document.getElementById('inv-date-in').value,
    time_in: document.getElementById('inv-time-in').value,
    return_date: document.getElementById('inv-return-time-tbc').checked ? null : document.getElementById('inv-return-date').value,
    return_time: document.getElementById('inv-return-time-tbc').checked ? null : document.getElementById('inv-return-time').value,
    stay_nights: (() => {
      const dateIn = document.getElementById('inv-date-in').value;
      const returnDate = document.getElementById('inv-return-time-tbc').checked ? null : document.getElementById('inv-return-date').value;
                  const timeIn = document.getElementById('inv-time-in').value;
                  const returnTime = document.getElementById('inv-return-time-tbc').checked ? null : document.getElementById('inv-return-time').value;
                  if (dateIn && returnDate) return calcNights24h(dateIn, timeIn, returnDate, returnTime);
      return parseInt(document.getElementById('inv-nights').value, 10) || 0;
    })(),
    flight_info: document.getElementById('inv-flight-info').value,
    flight_type: document.getElementById('inv-flight-type').value,
    total_price: document.getElementById('inv-total-price').value,
    discount_percent: document.getElementById('inv-discount-10').checked ? 10 : 0,
    paid_status: document.getElementById('inv-paid-status').value,
    payment_amount: document.getElementById('inv-payment-amount').value,
    paid_status_2: document.getElementById('inv-paid-status-2').value || null,
    payment_amount_2: document.getElementById('inv-payment-amount-2').value || 0,
    payment_date_1: document.getElementById('inv-payment-date-1').value || null,
    payment_date_2: document.getElementById('inv-payment-date-2').value || null,
    do_not_move: document.getElementById('inv-do-not-move').checked,
    picked_up: document.getElementById('inv-picked-up').value,
    staff_id: document.getElementById('inv-staff').value,
    notes: document.getElementById('inv-notes').value,
    customer_alert: getCustomerAlertText() || null,
    credit_applied: existingCreditApplied
  };

  _saving = true;
  const btn    = document.getElementById('btn-save');
  const btnNew = document.getElementById('btn-new-invoice');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Saving...';
  if (btnNew) btnNew.disabled = true;

  try {
    let res;
    if (currentInvoiceId) {
      res = await fetch(`/api/invoices/${currentInvoiceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    if (!res.ok) {
      const err = await res.json();
      showAlert(err.error || 'Failed to save invoice', 'danger');
      if (res.status === 409 && String(err.error || '').toLowerCase().includes('key')) {
        // The key list they were looking at was stale — refresh it so they
        // see accurate availability instead of hitting the same conflict again.
        populateKeySelectFromAvailable();
      }
    } else {
      const inv = await res.json();
      currentInvoiceId = inv.id;
      document.getElementById('inv-id').value = inv.id;
      document.getElementById('inv-status-badge').innerHTML = `<span class="badge bg-success">SAVED</span>`;

      // Actually consume the staged credit now that the invoice has a real ID.
      // This is the ONLY place that debits the credit ledger — the payload's
      // credit_applied field above just preserves whatever was already
      // recorded, it does not touch customer_credits itself.
      if (newlyStagedCredit > 0) {
        try {
          const creditRes = await fetch(`/api/invoices/${inv.id}/apply-credit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              amount: newlyStagedCredit,
              phone: payload.phone, first_name: payload.first_name, last_name: payload.last_name,
            })
          });
          if (creditRes.ok) {
            const creditResult = await creditRes.json();
            existingCreditApplied = parseFloat(creditResult.credit_applied) || existingCreditApplied;
            newlyStagedCredit = 0;
            document.getElementById('credit-display').innerHTML = `<span class="text-success">$${existingCreditApplied.toFixed(2)} applied</span>`;
            updateAmountDueHint();
          }
        } catch (e) { /* invoice itself is already saved successfully; credit consumption failing shouldn't block that */ }
      }

      if (inv.earlyReturnCredit) {
        showAlert(`💰 Customer picked up early — $${inv.earlyReturnCredit.amount.toFixed(2)} credit saved to their name for next visit.`, 'info');
      }

      // NOTE: do NOT touch save-btn-text here – the spinner already replaced
      // the button innerHTML so that span no longer exists.  The btn.innerHTML
      // line AFTER this try/catch restores the full button (including the span).
  document.getElementById('btn-print-receipt').disabled = false;
  document.getElementById('btn-email-receipt').disabled = false;
  document.getElementById('btn-void-invoice').disabled = false;
  document.getElementById('btn-refund').disabled = false;
  document.getElementById('btn-delete-invoice').disabled = false;
  showAlert('Invoice saved successfully!', 'success');
      history.replaceState(null, '', `/invoice.html?id=${inv.id}`);

      // Save customer if new
      if (!payload.customer_id && (payload.first_name || payload.last_name)) {
        const custRes = await fetch('/api/customers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            first_name: payload.first_name,
            last_name: payload.last_name,
            phone: payload.phone,
            email: payload.email
          })
        });
        if (custRes.ok) {
          const cust = await custRes.json();
          document.getElementById('inv-customer-id').value = cust.id;
        }
      }
    }
  } catch(err) {
    showAlert('Error saving invoice: ' + err.message, 'danger');
  }

  _saving = false;
  btn.disabled  = false;
  btn.innerHTML = `<i class="bi bi-floppy me-2"></i><span id="save-btn-text">UPDATE INVOICE</span>`;
  if (btnNew) btnNew.disabled = false;
  updateNavCarsCount();
});

// Print/View receipt
document.getElementById('btn-print-receipt').addEventListener('click', () => {
  if (currentInvoiceId) {
    window.open(`/api/invoices/${currentInvoiceId}/pdf`, '_blank');
  }
});

// Email receipt
document.getElementById('btn-email-receipt').addEventListener('click', async () => {
  if (!currentInvoiceId) return;
  const email = document.getElementById('inv-email').value;
  if (!email) { showAlert('No email address on this invoice – please enter one and save first.', 'warning'); return; }

  const btn = document.getElementById('btn-email-receipt');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Sending…';

  try {
    const res = await fetch(`/api/email/receipt/${currentInvoiceId}`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      showAlert(`✅ Receipt sent to ${escapeHtml(email)}`, 'success');
    } else {
      showAlert('Failed to send receipt: ' + (data.error || 'Unknown error'), 'danger');
    }
  } catch (err) {
    showAlert('Error sending receipt: ' + err.message, 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-envelope me-1"></i> Email Receipt';
  }
});

// Void invoice
document.getElementById('btn-void-invoice').addEventListener('click', async () => {
  if (!currentInvoiceId) return;
  if (!confirm('Are you sure you want to VOID this invoice? This cannot be undone.')) return;
  const res = await fetch(`/api/invoices/${currentInvoiceId}/void`, { method: 'POST' });
  if (res.ok) {
    showAlert('Invoice voided', 'warning');
    document.getElementById('inv-status-badge').innerHTML = `<span class="badge bg-secondary">VOIDED</span>`;
    document.getElementById('inv-picked-up').value = 'Voided';
    document.getElementById('btn-void-invoice').disabled = true;
    updateNavCarsCount();
  }
});

// Delete booking (permanent)
document.getElementById('btn-delete-invoice').addEventListener('click', async () => {
  if (!currentInvoiceId) return;
  const invNum = document.getElementById('inv-number-display').textContent;
  if (!confirm(`⚠️ PERMANENTLY DELETE Invoice #${invNum}?\n\nThis will remove the booking from the system and release the key.\nThis CANNOT be undone.`)) return;

  const btn = document.getElementById('btn-delete-invoice');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Deleting…';

  try {
    const res = await fetch(`/api/invoices/${currentInvoiceId}`, { method: 'DELETE' });
    if (res.ok) {
      showAlert(`Invoice #${invNum} deleted successfully.`, 'success');
      setTimeout(() => { window.location.href = '/invoice.html'; }, 1500);
    } else {
      const err = await res.json();
      showAlert('Failed to delete: ' + (err.error || 'Unknown error'), 'danger');
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-trash me-1"></i> Delete';
    }
  } catch (err) {
    showAlert('Error deleting invoice: ' + err.message, 'danger');
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-trash me-1"></i> Delete';
  }
  updateNavCarsCount();
});

// Refund
document.getElementById('btn-refund').addEventListener('click', () => {
  new bootstrap.Modal('#refundModal').show();
});

document.getElementById('btn-confirm-refund').addEventListener('click', async () => {
  if (!currentInvoiceId) return;
  const amount = document.getElementById('refund-amount').value;
  const reason = document.getElementById('refund-reason').value;
  const res = await fetch(`/api/invoices/${currentInvoiceId}/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refund_amount: amount, refund_reason: reason })
  });
  if (res.ok) {
    showAlert(`Refund of $${amount} recorded`, 'success');
    bootstrap.Modal.getInstance('#refundModal').hide();
  }
});

initInvoicePage();
