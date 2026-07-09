#!/usr/bin/env node
/**
 * Validates that "this month's revenue" queries are bounded correctly —
 * i.e. they sum from the 1st of the month THROUGH TODAY, not "from the 1st
 * onward forever". Without an upper bound, any future-dated row (e.g. a
 * long-term prepay prorated out to future months) gets wrongly counted as
 * if it happened this month, inflating the figure every time a multi-month
 * spread exists.
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();

  const carparkId = 1;
  let fail = false;
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail = true; } else { console.log('PASS:', msg); } };

  // Use a fixed "today" in the middle of a month so future months are unambiguous.
  const today = '2026-07-09';
  const firstOfMonth = '2026-07-01';

  const lt = await db.prepare(`INSERT INTO longterm_customers (lt_number, name, carpark_id, active) VALUES (?, 'Bound Test', ?, 1)`)
    .run(`LT-BOUND-${Date.now()}`, carparkId);
  const ltId = lt.lastInsertRowid;

  const createdPaymentIds = [];
  const mkPayment = async (date, amount) => {
    const r = await db.prepare(`INSERT INTO longterm_payments (carpark_id, longterm_customer_id, payment_date, amount_ex_gst, payment_method) VALUES (?, ?, ?, ?, 'Eftpos')`)
      .run(carparkId, ltId, date, amount);
    createdPaymentIds.push(r.lastInsertRowid);
  };

  await mkPayment('2026-07-05', 100);  // this month — should count
  await mkPayment('2026-08-14', 200);  // FUTURE month — must NOT count in July's total
  await mkPayment('2026-12-14', 300);  // far FUTURE month — must NOT count
  await mkPayment('2026-06-20', 400);  // PAST month — must NOT count in July's total

  const ltDay = `substr(trim(COALESCE(payment_date,'')), 1, 10)`;

  // The FIXED query (with upper bound) — what dashboard.js now runs
  const fixedResult = await db.prepare(`
    SELECT COALESCE(SUM(amount_ex_gst), 0) as total FROM longterm_payments
    WHERE carpark_id = ? AND ${ltDay} >= ? AND ${ltDay} <= ?
  `).get(carparkId, firstOfMonth, today);

  // The OLD buggy query (no upper bound) — for comparison, to prove the difference
  const buggyResult = await db.prepare(`
    SELECT COALESCE(SUM(amount_ex_gst), 0) as total FROM longterm_payments
    WHERE carpark_id = ? AND ${ltDay} >= ?
  `).get(carparkId, firstOfMonth);

  assert(fixedResult.total === 100, `fixed query correctly sums only July's $100 (got $${fixedResult.total})`);
  assert(buggyResult.total === 600, `old buggy query would have wrongly summed $600 (July + Aug + Dec) — confirms the bug this test guards against`);
  assert(fixedResult.total < buggyResult.total, 'fixed query result is strictly less than the buggy one, proving future months are now excluded');

  console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');

  // Cleanup
  await db.prepare('DELETE FROM longterm_payments WHERE id IN (' + createdPaymentIds.map(() => '?').join(',') + ')').run(...createdPaymentIds);
  await db.prepare('DELETE FROM longterm_customers WHERE id = ?').run(ltId);

  process.exit(fail ? 1 : 0);
})();
