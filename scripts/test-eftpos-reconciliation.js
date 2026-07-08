#!/usr/bin/env node
/**
 * Validates getEftposReconciliation / buildVarianceReport:
 * 1) Short-stay Eftpos payments (both legs) are included.
 * 2) A prorated long-term prepay swipe collapses into ONE line item (by
 *    cash_received_date/batch), not one per recognition month.
 * 3) Account Eftpos payments are included.
 * 4) Non-Eftpos payments (Cash, OnAcc, etc.) are correctly excluded.
 * 5) Variance math and matched/mismatched detection is correct.
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();
  const { getEftposReconciliation, buildVarianceReport } = require('../src/utils/eftposReconciliation');
  const { buildProratedPayments, inferContractMonths } = require('../src/utils/longtermProration');

  const carparkId = 1;
  const testDate = '2026-02-15'; // isolated date unlikely to collide with seed/demo data

  let fail = false;
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail = true; } else { console.log('PASS:', msg); } };

  const createdInvoiceIds = [];
  const createdLtPaymentIds = [];
  const createdAcctPaymentIds = [];
  let ltCustomerId = null;
  let acctId = null;

  // 1) Short-stay invoice — Eftpos, line 1 only
  const inv = await db.prepare(`
    INSERT INTO invoices (
      invoice_number, carpark_id, first_name, last_name, rego,
      date_in, time_in, return_date, return_time, total_price,
      paid_status, payment_amount, payment_date_1, void
    ) VALUES (?, ?, 'Recon', 'Test', 'RCN001', ?, '09:00', ?, '09:00', 55, 'Eftpos', 55, ?, 0)
  `).run(970000 + (Date.now() % 20000), carparkId, testDate, testDate, testDate);
  createdInvoiceIds.push(inv.lastInsertRowid);

  // A Cash invoice on the same day — must NOT be counted
  const invCash = await db.prepare(`
    INSERT INTO invoices (
      invoice_number, carpark_id, first_name, last_name, rego,
      date_in, time_in, return_date, return_time, total_price,
      paid_status, payment_amount, payment_date_1, void
    ) VALUES (?, ?, 'Recon', 'CashOnly', 'RCN002', ?, '09:30', ?, '09:30', 40, 'Cash', 40, ?, 0)
  `).run(970000 + (Date.now() % 20000) + 1, carparkId, testDate, testDate, testDate);
  createdInvoiceIds.push(invCash.lastInsertRowid);

  // 2) Long-term customer with a 12-month prepay swiped on testDate (Eftpos)
  const lt = await db.prepare(`INSERT INTO longterm_customers (lt_number, name, carpark_id, active, contract_start_date) VALUES (?, ?, ?, 1, ?)`)
    .run(`LT-RECON-${Date.now()}`, 'Recon LT Customer', carparkId, testDate);
  ltCustomerId = lt.lastInsertRowid;

  const months = inferContractMonths({ contract_start_date: testDate, expiry_date: null }, 1650);
  const proration = buildProratedPayments({
    totalAmountExGst: 1650,
    cashReceivedDate: testDate,
    contractStartDate: testDate,
    months,
  });
  for (const row of proration.rows) {
    const r = await db.prepare(`
      INSERT INTO longterm_payments (carpark_id, longterm_customer_id, payment_date, amount_ex_gst, payment_method, payment_batch_id, cash_received_date, notes)
      VALUES (?, ?, ?, ?, 'Eftpos', ?, ?, ?)
    `).run(carparkId, ltCustomerId, row.payment_date, row.amount_ex_gst, row.payment_batch_id, row.cash_received_date, row.notes);
    createdLtPaymentIds.push(r.lastInsertRowid);
  }

  // 3) Account customer Eftpos payment on testDate
  const acct = await db.prepare(`INSERT INTO account_customers (company_name, carpark_id, active) VALUES (?, ?, 1)`)
    .run(`TEST-RECON-ACCT-${Date.now()}`, carparkId);
  acctId = acct.lastInsertRowid;
  const acctPay = await db.prepare(`INSERT INTO account_payments (carpark_id, account_customer_id, payment_date, amount, payment_method) VALUES (?, ?, ?, ?, 'Eftpos')`)
    .run(carparkId, acctId, testDate, 75);
  createdAcctPaymentIds.push(acctPay.lastInsertRowid);

  // A non-Eftpos account payment — must NOT be counted
  const acctPayBank = await db.prepare(`INSERT INTO account_payments (carpark_id, account_customer_id, payment_date, amount, payment_method) VALUES (?, ?, ?, ?, 'Internet Bank')`)
    .run(carparkId, acctId, testDate, 999);
  createdAcctPaymentIds.push(acctPayBank.lastInsertRowid);

  // ── Run reconciliation ──────────────────────────────────────────────────
  const rec = await getEftposReconciliation(db, { carparkId, date: testDate });

  assert(rec.items.some(i => i.source === 'Short-stay' && i.amount === 55), 'includes the $55 short-stay Eftpos invoice');
  assert(!rec.items.some(i => i.amount === 40), 'excludes the $40 Cash invoice');
  assert(rec.items.filter(i => i.source === 'Long-term').length === 1, `LT prepay collapses to 1 line item (got ${rec.items.filter(i => i.source === 'Long-term').length})`);
  assert(rec.items.some(i => i.source === 'Long-term' && i.amount === 1650), 'LT line item totals the full $1650 swipe, not a fraction');
  assert(rec.items.some(i => i.source === 'Account' && i.amount === 75), 'includes the $75 account Eftpos payment');
  assert(!rec.items.some(i => i.amount === 999), 'excludes the $999 non-Eftpos account payment');

  const expected = 55 + 1650 + 75;
  assert(rec.expectedTotal === expected, `expected total is $${expected} (got $${rec.expectedTotal})`);

  const matchCheck = buildVarianceReport(rec, expected);
  assert(matchCheck.matched === true && matchCheck.variance === 0, 'matching machine total reports matched=true, variance=0');

  const mismatchCheck = buildVarianceReport(rec, expected - 20);
  assert(mismatchCheck.matched === false && mismatchCheck.variance === -20, `mismatched machine total reports variance=-20 (got ${mismatchCheck.variance})`);
  assert(mismatchCheck.warnings.length > 0, 'mismatch produces at least one trace warning');

  console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');

  // Cleanup
  await db.prepare('DELETE FROM invoices WHERE id IN (' + createdInvoiceIds.map(() => '?').join(',') + ')').run(...createdInvoiceIds);
  await db.prepare('DELETE FROM longterm_payments WHERE id IN (' + createdLtPaymentIds.map(() => '?').join(',') + ')').run(...createdLtPaymentIds);
  await db.prepare('DELETE FROM longterm_customers WHERE id = ?').run(ltCustomerId);
  await db.prepare('DELETE FROM account_payments WHERE id IN (' + createdAcctPaymentIds.map(() => '?').join(',') + ')').run(...createdAcctPaymentIds);
  await db.prepare('DELETE FROM account_customers WHERE id = ?').run(acctId);

  process.exit(fail ? 1 : 0);
})();
