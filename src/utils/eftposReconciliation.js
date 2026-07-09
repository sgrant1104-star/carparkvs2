/**
 * Eftpos reconciliation.
 *
 * Every payment recorded in the system as "Eftpos" — regardless of whether
 * it came from a short-stay invoice, a long-term prepayment, or an account
 * payment — physically went through the same in-house terminal. This builds
 * the itemised list of everything the system THINKS went through the
 * terminal on a given business date, so it can be checked against the
 * terminal's own Z-report / batch total.
 *
 * Sources covered:
 *  1. Short-stay invoices, payment line 1 (paid_status = 'Eftpos')
 *  2. Short-stay invoices, payment line 2 (paid_status_2 = 'Eftpos')
 *  3. Long-term prepayments (longterm_payments.payment_method = 'Eftpos'),
 *     grouped by the ACTUAL swipe (cash_received_date / batch), not by the
 *     accounting recognition month — a single 12-month prepay swipe must
 *     reconcile as ONE terminal transaction, not twelve.
 *  4. Account-customer payments (account_payments.payment_method = 'Eftpos')
 *
 * Invoice lines use the same "effective payment day" logic as Banking/EOD
 * (payment_date_1/2, falling back to date_in for legacy rows) so this
 * matches what already appears in End of Day / Banking totals.
 */

const { EFFECTIVE_PAY1_DAY, EFFECTIVE_PAY2_DAY } = require('./invoicePaymentDates');
const { collapsePaymentsForDisplay } = require('./longtermProration');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function getEftposReconciliation(db, { carparkId, date }) {
  const items = [];

  // 1) Short-stay invoices — payment line 1
  const inv1 = await db.prepare(`
    SELECT id, invoice_number, first_name, last_name, rego, payment_amount, time_in
    FROM invoices
    WHERE carpark_id = ? AND void = 0 AND paid_status = 'Eftpos'
      AND COALESCE(payment_amount, 0) > 0
      AND (${EFFECTIVE_PAY1_DAY}) = ?
    ORDER BY time_in
  `).all(carparkId, date);
  for (const r of inv1) {
    items.push({
      source: 'Short-stay',
      ref: `Invoice #${r.invoice_number}`,
      description: `${r.first_name || ''} ${r.last_name || ''} — ${r.rego || ''}`.trim(),
      time: r.time_in || '',
      amount: round2(r.payment_amount),
      link: `/invoice.html?id=${r.id}`,
    });
  }

  // 2) Short-stay invoices — payment line 2 (second/split payment)
  const inv2 = await db.prepare(`
    SELECT id, invoice_number, first_name, last_name, rego, payment_amount_2, time_in
    FROM invoices
    WHERE carpark_id = ? AND void = 0 AND paid_status_2 = 'Eftpos'
      AND COALESCE(payment_amount_2, 0) > 0
      AND (${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) = ?
    ORDER BY time_in
  `).all(carparkId, date);
  for (const r of inv2) {
    items.push({
      source: 'Short-stay',
      ref: `Invoice #${r.invoice_number} (2nd payment)`,
      description: `${r.first_name || ''} ${r.last_name || ''} — ${r.rego || ''}`.trim(),
      time: r.time_in || '',
      amount: round2(r.payment_amount_2),
      link: `/invoice.html?id=${r.id}`,
    });
  }

  // 3) Long-term prepayments — group by swipe (batch), not by recognition month
  const ltRows = await db.prepare(`
    SELECT lp.*, lc.lt_number, lc.name
    FROM longterm_payments lp
    JOIN longterm_customers lc ON lc.id = lp.longterm_customer_id
    WHERE lp.carpark_id = ? AND lp.payment_method = 'Eftpos'
      AND substr(trim(COALESCE(NULLIF(trim(lp.cash_received_date), ''), lp.payment_date)), 1, 10) = ?
  `).all(carparkId, date);
  const ltRefByBatch = new Map();
  for (const r of ltRows) {
    // Must match the same key collapsePaymentsForDisplay() uses: batch_id when
    // present, otherwise the raw row id (NOT a prefixed string) — legacy rows
    // predating payment_batch_id fall into the second case.
    const key = r.payment_batch_id || r.id;
    if (!ltRefByBatch.has(key)) ltRefByBatch.set(key, `${r.lt_number} — ${r.name}`);
  }
  const ltCollapsed = collapsePaymentsForDisplay(ltRows);
  for (const b of ltCollapsed) {
    const key = b.id;
    items.push({
      source: 'Long-term',
      ref: ltRefByBatch.get(key) || 'Long-term customer',
      description: b.is_prorated ? `Prepay — spread over ${b.months} months` : (b.notes || 'Long-term payment'),
      time: '',
      amount: round2(b.amount_ex_gst),
      link: null,
    });
  }

  // 4) Account-customer payments
  const acctRows = await db.prepare(`
    SELECT ap.*, ac.company_name
    FROM account_payments ap
    JOIN account_customers ac ON ac.id = ap.account_customer_id
    WHERE ap.carpark_id = ? AND ap.payment_method = 'Eftpos'
      AND substr(trim(COALESCE(ap.payment_date, '')), 1, 10) = ?
  `).all(carparkId, date);
  for (const r of acctRows) {
    items.push({
      source: 'Account',
      ref: r.company_name,
      description: r.transaction_reference || r.notes || 'Account payment',
      time: '',
      amount: round2(r.amount),
      link: `/accounts.html?id=${r.account_customer_id}`,
    });
  }

  items.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
  const expectedTotal = round2(items.reduce((sum, i) => sum + i.amount, 0));

  return { date, items, expectedTotal, count: items.length };
}

/**
 * When there's a mismatch, actively find and return the specific candidates
 * worth checking — not just generic advice. Two kinds of leads:
 *
 *  1. "Unpaid today" — invoices touching this date (booked in, or picked up/
 *     returned) that are STILL marked "To Pay". If the terminal shows more
 *     than the system expected, one of these is the most likely explanation:
 *     the customer paid by card but it was never marked Eftpos in the system.
 *
 *  2. "Neighbouring day totals" — the same Eftpos figure for yesterday and
 *     tomorrow. A payment entered under the wrong date is a common cause of
 *     a mismatch in EITHER direction, and an unusually high adjacent-day
 *     total is a concrete clue pointing at which day to check.
 */
async function findMismatchSuspects(db, { carparkId, date }) {
  const unpaidToday = await db.prepare(`
    SELECT id, invoice_number, first_name, last_name, rego, total_price, date_in, time_in, return_date, paid_status
    FROM invoices
    WHERE carpark_id = ? AND void = 0
      AND (substr(trim(COALESCE(date_in,'')),1,10) = ? OR substr(trim(COALESCE(return_date,'')),1,10) = ?)
      AND paid_status = 'To Pay'
      AND COALESCE(total_price, 0) > 0
    ORDER BY time_in
  `).all(carparkId, date, date);

  const prevDate = shiftDate(date, -1);
  const nextDate = shiftDate(date, 1);
  const [prevRecon, nextRecon] = await Promise.all([
    getEftposReconciliation(db, { carparkId, date: prevDate }),
    getEftposReconciliation(db, { carparkId, date: nextDate }),
  ]);

  return {
    unpaidToday: unpaidToday.map(r => ({
      id: r.id,
      ref: `Invoice #${r.invoice_number}`,
      description: `${r.first_name || ''} ${r.last_name || ''} — ${r.rego || ''}`.trim(),
      amount: round2(r.total_price),
      link: `/invoice.html?id=${r.id}`,
    })),
    neighbouringDays: {
      previous: { date: prevDate, total: prevRecon.expectedTotal, count: prevRecon.count },
      next: { date: nextDate, total: nextRecon.expectedTotal, count: nextRecon.count },
    },
  };
}

function shiftDate(dateStr, days) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Compares the system's expected Eftpos total to what staff typed in from
 * the terminal's Z-report, and produces a plain-English trace of what to
 * check if they don't match.
 */
function buildVarianceReport(reconciliation, machineTotal) {
  const expected = reconciliation.expectedTotal;
  const machine = machineTotal == null ? null : round2(machineTotal);
  if (machine == null) {
    return { expected, machine: null, variance: null, matched: null, warnings: [] };
  }
  const variance = round2(machine - expected);
  const matched = Math.abs(variance) < 0.01;
  const warnings = [];

  if (!matched) {
    if (variance > 0) {
      warnings.push(
        `The terminal shows $${machine.toFixed(2)}, which is $${Math.abs(variance).toFixed(2)} MORE than the ` +
        `$${expected.toFixed(2)} the system expected. Most likely: one of the invoices below marked "To Pay" ` +
        `was actually paid by card and never recorded, or a payment landed under the wrong date — check the ` +
        `neighbouring-day totals below too.`
      );
    } else {
      warnings.push(
        `The terminal shows $${machine.toFixed(2)}, which is $${Math.abs(variance).toFixed(2)} LESS than the ` +
        `$${expected.toFixed(2)} the system expected. Most likely: one of the transactions in the list above was ` +
        `marked "Eftpos" but the customer actually paid cash/bank transfer, a payment date was entered for the ` +
        `wrong day (check the neighbouring-day totals below), or a decline/refund on the terminal wasn't ` +
        `reflected back in the invoice.`
      );
    }
    if (reconciliation.items.length === 0) {
      warnings.push('No Eftpos-tagged transactions were found in the system for this date at all — check the date is correct and that today\'s takings have actually been saved against invoices/payments yet.');
    }
  }

  return { expected, machine, variance, matched, warnings };
}

module.exports = { getEftposReconciliation, buildVarianceReport, findMismatchSuspects };
