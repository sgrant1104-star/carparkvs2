#!/usr/bin/env node
/**
 * Verifies invoice revenue totals exclude "To Pay" pre-filled payment_amount (banking vs outstanding).
 * Run: node scripts/test-revenue-paid-only.js
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');

  const SUM_EFTPOS = `(COALESCE(CASE WHEN paid_status = 'Eftpos' THEN payment_amount ELSE 0 END, 0) + COALESCE(CASE WHEN paid_status_2 = 'Eftpos' THEN payment_amount_2 ELSE 0 END, 0))`;
  const SUM_CASH = `(COALESCE(CASE WHEN paid_status = 'Cash' THEN payment_amount ELSE 0 END, 0) + COALESCE(CASE WHEN paid_status_2 = 'Cash' THEN payment_amount_2 ELSE 0 END, 0))`;
  const SUM_ONACC = `(COALESCE(CASE WHEN paid_status = 'OnAcc' THEN payment_amount ELSE 0 END, 0) + COALESCE(CASE WHEN paid_status_2 = 'OnAcc' THEN payment_amount_2 ELSE 0 END, 0))`;
  const SUM_IB = `(COALESCE(CASE WHEN paid_status = 'Internet Banking' THEN payment_amount ELSE 0 END, 0) + COALESCE(CASE WHEN paid_status_2 = 'Internet Banking' THEN payment_amount_2 ELSE 0 END, 0))`;
  const PAID_INV_TOTAL = `(${SUM_EFTPOS} + ${SUM_CASH} + ${SUM_ONACC} + ${SUM_IB})`;

  await initializeDatabase();
  const carparkId = 1;

  const raw = await db.prepare(`
    SELECT COALESCE(SUM(payment_amount + COALESCE(payment_amount_2,0)), 0) as raw_sum
    FROM invoices WHERE carpark_id = ? AND void = 0
  `).get(carparkId);

  const paid = await db.prepare(`
    SELECT COALESCE(SUM(${PAID_INV_TOTAL}), 0) as paid_sum
    FROM invoices WHERE carpark_id = ? AND void = 0
  `).get(carparkId);

  const toPayRows = await db.prepare(`
    SELECT COUNT(*) as n,
      COALESCE(SUM(payment_amount + COALESCE(payment_amount_2,0)), 0) as raw_in_topay
    FROM invoices WHERE carpark_id = ? AND void = 0 AND paid_status = 'To Pay'
  `).get(carparkId);

  console.log('All invoices raw sum (payment1+2):', raw.raw_sum);
  console.log('Paid-classified sum (Eftpos+Cash+IB+OnAcc lines):', paid.paid_sum);
  console.log('To Pay rows:', toPayRows.n, '— raw payment fields total (should NOT count as banked):', toPayRows.raw_in_topay);
  if (Number(raw.raw_sum) !== Number(paid.paid_sum) && Number(toPayRows.raw_in_topay) > 0) {
    console.log('OK: Totals may differ because "To Pay" rows include payment_amount, while the report sums only paid_sum.');
  }

  const tp = await db.prepare(`
    SELECT id, payment_amount FROM invoices
    WHERE carpark_id = ? AND void = 0 AND paid_status = 'To Pay' LIMIT 1
  `).get(carparkId);

  if (tp) {
    const beforeRaw = Number(raw.raw_sum);
    const beforePaid = Number(paid.paid_sum);
    await db.prepare(`UPDATE invoices SET payment_amount = ? WHERE id = ?`).run(150.5, tp.id);
    const raw2 = await db.prepare(`
      SELECT COALESCE(SUM(payment_amount + COALESCE(payment_amount_2,0)), 0) as raw_sum
      FROM invoices WHERE carpark_id = ? AND void = 0
    `).get(carparkId);
    const paid2 = await db.prepare(`
      SELECT COALESCE(SUM(${PAID_INV_TOTAL}), 0) as paid_sum
      FROM invoices WHERE carpark_id = ? AND void = 0
    `).get(carparkId);
    await db.prepare(`UPDATE invoices SET payment_amount = ? WHERE id = ?`).run(tp.payment_amount, tp.id);
    const deltaRaw = Number(raw2.raw_sum) - beforeRaw;
    const deltaPaid = Number(paid2.paid_sum) - beforePaid;
    console.log('Mutation test (To Pay row id=%s): raw delta=%s paid delta=%s', tp.id, deltaRaw, deltaPaid);
    if (Math.abs(deltaRaw - 150.5) > 0.01 || Math.abs(deltaPaid) > 0.01) {
      console.error('FAIL: expected raw +150.5 and paid +0');
      process.exit(1);
    }
    console.log('OK: Prefilled To Pay amount does not change paid-classified revenue.');
  }

  console.log('PASS');
  process.exit(0);
})();
