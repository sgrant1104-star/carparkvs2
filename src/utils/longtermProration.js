/**
 * Long-term prepayment proration — spread lump sums across contract months
 * so monthly revenue / reports reflect accrual, not cash-on-receipt.
 */

const LT_TERM_TOTALS = { 1: 200, 3: 500, 6: 1000, 12: 1650 };
const LT_MONTHLY_RATE = 200;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymdFromDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseYmd(ymd) {
  if (!ymd) return null;
  const s = String(ymd).slice(0, 10);
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/** Add calendar months to YYYY-MM-DD (clamps day when month is shorter). */
function addMonthsYmd(ymd, months) {
  const d = parseYmd(ymd);
  if (!d) return ymd;
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() !== day) d.setDate(0);
  return ymdFromDate(d);
}

/** Whole calendar months between two dates (minimum 1 when end > start). */
function monthsBetweenYmd(startYmd, endYmd) {
  const a = parseYmd(startYmd);
  const b = parseYmd(endYmd);
  if (!a || !b) return 0;
  let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() >= a.getDate()) months += 1;
  else months += 0;
  return Math.max(0, months);
}

function nearEqual(a, b, eps = 0.02) {
  return Math.abs(Number(a) - Number(b)) <= eps;
}

/**
 * Amount-ONLY month inference — deliberately does NOT look at the customer's
 * contract_start_date/expiry_date, unlike inferContractMonths() above.
 *
 * Use this (not inferContractMonths) when backfilling OLD historical
 * payments. Here's why: a customer's contract_start_date/expiry_date on
 * file reflects their CURRENT/latest contract term — it says nothing about
 * what was true when an old payment was made. Using it to judge historical
 * payments causes exactly the bug this function avoids: every past payment
 * for a customer gets stamped with whatever their current contract span
 * happens to be, regardless of that payment's own actual amount, silently
 * merging distinct payments into the same wrong months.
 *
 * Deliberately conservative: only classifies a payment as multi-month if
 * its amount closely matches one of the known term totals. Anything
 * ambiguous returns 1 (leave alone, don't guess) rather than risk
 * misattributing historical revenue to the wrong month.
 */
function inferMonthsFromAmountOnly(amountExGst) {
  const amt = Number(amountExGst);
  if (!Number.isFinite(amt) || amt <= 0) return 1;
  for (const [m, total] of Object.entries(LT_TERM_TOTALS)) {
    if (parseInt(m, 10) > 1 && nearEqual(amt, total)) return parseInt(m, 10);
  }
  return 1;
}

/** True if a YYYY-MM-DD string parses to a real, plausible date (year 2000-2100). */
function isPlausibleDate(ymd) {
  const d = parseYmd(ymd);
  if (!d || isNaN(d.getTime())) return false;
  const year = d.getFullYear();
  return year >= 2000 && year <= 2100;
}

/**
 * Infer how many months a payment covers.
 * Priority: contract dates → known term totals → contract_amount match → single month.
 */
function inferContractMonths(customer, amountExGst) {
  const amt = Number(amountExGst);
  if (!Number.isFinite(amt) || amt <= 0) return 1;

  const start = customer.contract_start_date ? String(customer.contract_start_date).slice(0, 10) : null;
  const expiry = customer.expiry_date ? String(customer.expiry_date).slice(0, 10) : null;

  if (start && expiry) {
    const fromDates = monthsBetweenYmd(start, expiry);
    if (fromDates >= 2 && fromDates <= 12) return fromDates;
  }

  for (const [m, total] of Object.entries(LT_TERM_TOTALS)) {
    if (nearEqual(amt, total)) return parseInt(m, 10);
  }

  const contractAmt = customer.contract_amount != null && customer.contract_amount !== ''
    ? parseFloat(customer.contract_amount) : null;
  if (contractAmt != null && nearEqual(amt, contractAmt) && start && expiry) {
    const m = monthsBetweenYmd(start, expiry);
    if (m >= 2 && m <= 12) return m;
  }

  if (amt > LT_MONTHLY_RATE + 0.01) {
    for (const [m, total] of Object.entries(LT_TERM_TOTALS)) {
      if (m > 1 && nearEqual(amt, total)) return parseInt(m, 10);
    }
    const guessed = Math.round(amt / LT_MONTHLY_RATE);
    if (guessed >= 2 && guessed <= 12 && nearEqual(amt, guessed * LT_MONTHLY_RATE, 5)) return guessed;
  }

  return 1;
}

/** Split total into N parts; remainder on last slice (2 dp). */
function splitAmount(total, parts) {
  if (parts <= 1) return [Math.round(total * 100) / 100];
  const base = Math.floor((total / parts) * 100) / 100;
  const amounts = Array(parts - 1).fill(base);
  const last = Math.round((total - base * (parts - 1)) * 100) / 100;
  amounts.push(last);
  return amounts;
}

/**
 * Build prorated payment rows for DB insert.
 * @returns {{ batchId: string, rows: Array<{ payment_date, amount_ex_gst, notes }> }}
 */
function buildProratedPayments({
  totalAmountExGst,
  cashReceivedDate,
  contractStartDate,
  months,
  baseNotes,
  transactionReference,
}) {
  const total = Math.round(Number(totalAmountExGst) * 100) / 100;
  const m = Math.max(1, Math.min(12, parseInt(months, 10) || 1));
  const batchId = `ltb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const start = contractStartDate
    ? String(contractStartDate).slice(0, 10)
    : String(cashReceivedDate).slice(0, 10);

  if (m === 1) {
    return {
      batchId,
      months: 1,
      rows: [{
        payment_date: String(cashReceivedDate).slice(0, 10),
        amount_ex_gst: total,
        cash_received_date: String(cashReceivedDate).slice(0, 10),
        payment_batch_id: batchId,
        notes: baseNotes || null,
      }],
    };
  }

  const amounts = splitAmount(total, m);
  const refNote = transactionReference ? ` Ref: ${transactionReference}` : '';
  const rows = amounts.map((amt, i) => ({
    payment_date: addMonthsYmd(start, i),
    amount_ex_gst: amt,
    cash_received_date: String(cashReceivedDate).slice(0, 10),
    payment_batch_id: batchId,
    notes: i === 0
      ? `Prepay spread over ${m} months ($${total.toFixed(2)} ex GST).${refNote}${baseNotes ? ` ${baseNotes}` : ''}`
      : `Month ${i + 1}/${m} recognition`,
  }));

  return { batchId, months: m, rows };
}

/** Collapse prorated rows for payment-history display. */
function collapsePaymentsForDisplay(payments) {
  const singles = [];
  const batches = new Map();

  for (const p of payments) {
    const bid = p.payment_batch_id;
    if (!bid) {
      singles.push(p);
      continue;
    }
    if (!batches.has(bid)) {
      batches.set(bid, {
        batch_id: bid,
        payment_date: p.cash_received_date || p.payment_date,
        cash_received_date: p.cash_received_date || p.payment_date,
        payment_method: p.payment_method,
        transaction_reference: p.transaction_reference,
        amount_ex_gst: 0,
        months: 0,
        notes: p.notes,
        allocations: [],
      });
    }
    const b = batches.get(bid);
    b.amount_ex_gst = Math.round((b.amount_ex_gst + Number(p.amount_ex_gst || 0)) * 100) / 100;
    b.months += 1;
    b.allocations.push({
      payment_date: p.payment_date,
      amount_ex_gst: p.amount_ex_gst,
    });
  }

  const collapsed = [
    ...singles,
    ...Array.from(batches.values()).map(b => ({
      id: b.batch_id,
      payment_date: b.cash_received_date,
      amount_ex_gst: b.amount_ex_gst,
      payment_method: b.payment_method,
      transaction_reference: b.transaction_reference,
      notes: b.notes,
      is_prorated: true,
      months: b.months,
      allocations: b.allocations,
    })),
  ];

  collapsed.sort((a, b) => String(b.payment_date).localeCompare(String(a.payment_date)));
  return collapsed;
}

module.exports = {
  LT_TERM_TOTALS,
  LT_MONTHLY_RATE,
  addMonthsYmd,
  monthsBetweenYmd,
  inferContractMonths,
  inferMonthsFromAmountOnly,
  isPlausibleDate,
  splitAmount,
  buildProratedPayments,
  collapsePaymentsForDisplay,
};
