#!/usr/bin/env node
/**
 * Legacy invoice: Eftpos + payment_date_1 NULL → EOD must still count (effective day = date_in).
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  const { EFFECTIVE_PAY1_DAY, EFFECTIVE_PAY2_DAY } = require('../src/utils/invoicePaymentDates');
  await initializeDatabase();
  const carparkId = 1;
  const day = '2026-04-07';

  const ins = await db.prepare(`
    INSERT INTO invoices (
      invoice_number, carpark_id, first_name, last_name, date_in, time_in,
      total_price, paid_status, payment_amount, payment_date_1, void
    ) VALUES (?, ?, 'T','Test', ?, '10:00', 54, 'Eftpos', 54, NULL, 0)
  `).run(910000 + (Date.now() % 10000), carparkId, day);

  const stats = await db.prepare(`
    SELECT
      COALESCE(SUM(
        COALESCE(CASE WHEN (${EFFECTIVE_PAY1_DAY}) = ? AND paid_status = 'Eftpos' THEN payment_amount ELSE 0 END, 0) +
        COALESCE(CASE WHEN (${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) = ? AND paid_status_2 = 'Eftpos' THEN payment_amount_2 ELSE 0 END, 0)
      ), 0) as eftpos
    FROM invoices WHERE carpark_id = ? AND void = 0
  `).get(day, day, carparkId);

  await db.prepare('DELETE FROM invoices WHERE id = ?').run(ins.lastInsertRowid);

  if (Number(stats.eftpos) < 54) {
    console.error('FAIL eftpos', stats.eftpos);
    process.exit(1);
  }
  console.log('PASS eftpos for legacy row:', stats.eftpos);
  process.exit(0);
})();
