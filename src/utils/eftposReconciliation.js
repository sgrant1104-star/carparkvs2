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
        `$${expected.toFixed(2)} the system expected. Likely causes: a booking was taken by card but not yet ` +
        `recorded as "Eftpos" in an invoice/payment (still shows "To Pay"), or a payment was recorded under ` +
        `the wrong date. Check invoices still marked "To Pay" today, and any Eftpos payments recorded on a ` +
        `neighbouring day (yesterday/tomorrow) that may actually belong to today's batch.`
      );
    } else {
      warnings.push(
        `The terminal shows $${machine.toFixed(2)}, which is $${Math.abs(variance).toFixed(2)} LESS than the ` +
        `$${expected.toFixed(2)} the system expected. Likely causes: a booking was marked "Eftpos" in the ` +
        `system but the customer actually paid cash/bank transfer, a payment date was entered incorrectly ` +
        `(pulling a transaction from another day into today's total), or a refund/decline on the terminal ` +
        `wasn't reflected back in the invoice.`
      );
    }
    if (reconciliation.items.length === 0) {
      warnings.push('No Eftpos-tagged transactions were found in the system for this date at all — check the date is correct and that today\'s takings have actually been saved against invoices/payments yet.');
    }
  }

  return { expected, machine, variance, matched, warnings };
}

module.exports = { getEftposReconciliation, buildVarianceReport };
