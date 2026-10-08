/**
 * Customer-facing wording for an invoice's payment state, shared by the
 * receipt PDF and the receipt email so the two can never say different
 * things. (Previously each decided its own labels, and both showed internal
 * codes like "OnAcc" and called an On Account booking "PAYMENT PENDING
 * CONFIRMATION", which made no sense to the account holder.)
 */
const { computeInvoicePaymentStatus } = require('./paymentAllocation');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const currency = (n) => `$${parseFloat(n || 0).toFixed(2)}`;

const METHOD_LABELS = {
  OnAcc: 'On Account',
  'Internet Banking': 'Internet Banking',
  Eftpos: 'Eftpos',
  Cash: 'Cash',
  'Customer Credit': 'Customer Credit',
  'To Pay': 'To Pay',
};

/** Internal paid_status code -> what the customer should read. */
function methodLabel(status) {
  const s = String(status || '').trim();
  return METHOD_LABELS[s] || s || '—';
}

function onAccountAmount(inv) {
  let n = 0;
  if (String(inv.paid_status || '').trim() === 'OnAcc') n += parseFloat(inv.payment_amount) || 0;
  if (String(inv.paid_status_2 || '').trim() === 'OnAcc') n += parseFloat(inv.payment_amount_2) || 0;
  return round2(n);
}

/**
 * Banner shown at the top of the money section.
 * kind: 'paid' | 'onaccount' | 'pending' | 'due'
 */
function invoiceStatusBanner(invoice) {
  const st = computeInvoicePaymentStatus(invoice);
  const onAcc = onAccountAmount(invoice);
  const ibPending = round2(Math.max(0, st.pending - onAcc));

  if (st.isPaidInFull) return { kind: 'paid', label: 'PAID IN FULL', color: '#1e8449', note: null, ...st, onAcc, ibPending };

  // On Account is billed on the monthly statement — it is not "awaiting
  // confirmation", so don't label it that way.
  if (onAcc > 0.01 && ibPending < 0.01) {
    return {
      kind: 'onaccount',
      label: st.owing > 0.01 ? `ON ACCOUNT ${currency(onAcc)} + DUE ${currency(st.owing)}` : `ON ACCOUNT: ${currency(onAcc)}`,
      color: '#1a5276',
      note: 'Billed on your monthly account statement.',
      ...st, onAcc, ibPending,
    };
  }

  if (st.pending > 0.01) {
    return {
      kind: 'pending',
      label: st.owing > 0.01
        ? `PENDING ${currency(st.pending)} + DUE ${currency(st.owing)}`
        : `PAYMENT PENDING CONFIRMATION: ${currency(st.pending)}`,
      color: '#d68910', note: null, ...st, onAcc, ibPending,
    };
  }

  return { kind: 'due', label: `AMOUNT DUE: ${currency(st.owing)}`, color: '#c0392b', note: null, ...st, onAcc, ibPending };
}

/** Rego as customers expect to read it (data entry is a mix of cases). */
function displayRego(rego) {
  return String(rego || '').trim().toUpperCase() || '—';
}

module.exports = { methodLabel, invoiceStatusBanner, displayRego, onAccountAmount, currency };
