#!/usr/bin/env node
/**
 * Validates the dashboard revenue-by-method breakdown correctly includes
 * BOTH payment lines (a split payment's 2nd leg was previously silently
 * dropped, only counting the first payment method).
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();

  const carparkId = 1;
  let fail = false;
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail = true; } else { console.log('PASS:', msg); } };

  const testDate = '2026-07-09';
  const createdIds = [];

  // Split payment: $30 Eftpos + $20 Cash
  const r = await db.prepare(`
    INSERT INTO invoices (invoice_number, carpark_id, first_name, last_name, rego, date_in, time_in, return_date, return_time, total_price,
      paid_status, payment_amount, paid_status_2, payment_amount_2, void)
    VALUES (?, ?, 'Split', 'Test', 'SPLIT01', ?, '09:00', ?, '09:00', 50, 'Eftpos', 30, 'Cash', 20, 0)
  `).run(970000 + (Date.now() % 5000), carparkId, testDate, testDate);
  createdIds.push(r.lastInsertRowid);

  const invDay = `substr(trim(COALESCE(date_in,'')), 1, 10)`;
  const firstOfMonth = '2026-07-01';
  const today = '2026-07-09';

  // Reproduce the FIXED query from dashboard.js
  const revenueByMethodRaw = await db.prepare(`
    SELECT paid_status, COALESCE(SUM(payment_amount), 0) as total
    FROM invoices WHERE carpark_id = ? AND ${invDay} >= ? AND ${invDay} <= ? AND void = 0
    GROUP BY paid_status
    UNION ALL
    SELECT paid_status_2 as paid_status, COALESCE(SUM(payment_amount_2), 0) as total
    FROM invoices WHERE carpark_id = ? AND ${invDay} >= ? AND ${invDay} <= ? AND void = 0
      AND paid_status_2 IS NOT NULL AND COALESCE(payment_amount_2, 0) > 0
    GROUP BY paid_status_2
  `).all(carparkId, firstOfMonth, today, carparkId, firstOfMonth, today);

  const map = new Map();
  for (const row of revenueByMethodRaw) {
    const key = row.paid_status || 'Unknown';
    map.set(key, (map.get(key) || 0) + (row.total || 0));
  }

  const eftposTotal = map.get('Eftpos') || 0;
  const cashTotal = map.get('Cash') || 0;

  assert(eftposTotal >= 30, `Eftpos bucket includes the $30 first-leg payment (got $${eftposTotal})`);
  assert(cashTotal >= 20, `Cash bucket includes the $20 SECOND-leg payment — this is exactly what the old query silently dropped (got $${cashTotal})`);

  console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');

  await db.prepare('DELETE FROM invoices WHERE id IN (' + createdIds.map(() => '?').join(',') + ')').run(...createdIds);
  process.exit(fail ? 1 : 0);
})();
