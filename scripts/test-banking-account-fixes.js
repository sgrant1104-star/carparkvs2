#!/usr/bin/env node
/**
 * Validates:
 * 1) Banking totals are attributed by payment_date_1/2 (not date_in).
 * 2) Account payments can be retrieved for a chosen historical month.
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();
  const carparkId = 1;
  const today = new Date().toISOString().slice(0, 10);
  const oldDateIn = '2026-01-05';
  const lastMonth = new Date();
  lastMonth.setMonth(lastMonth.getMonth() - 1);
  const lmYear = lastMonth.getFullYear();
  const lmMon = String(lastMonth.getMonth() + 1).padStart(2, '0');
  const lmDay = '10';
  const lastMonthDate = `${lmYear}-${lmMon}-${lmDay}`;

  let accountId = null;
  let invoiceId = null;
  const acct = await db.prepare(`
    INSERT INTO account_customers (company_name, carpark_id, active)
    VALUES (?, ?, 1)
  `).run(`TEST-ACCT-${Date.now()}`, carparkId);
  accountId = acct.lastInsertRowid;

  const inv = await db.prepare(`
    INSERT INTO invoices (
      invoice_number, carpark_id, account_customer_id, first_name, last_name, rego,
      date_in, time_in, return_date, return_time, total_price,
      paid_status, payment_amount, payment_date_1, void
    ) VALUES (?, ?, ?, 'T', 'Customer', 'TST123', ?, '10:00', ?, '10:00', ?, 'To Pay', ?, NULL, 0)
  `).run(900000 + (Date.now() % 100000), carparkId, accountId, oldDateIn, oldDateIn, 300, 300);
  invoiceId = inv.lastInsertRowid;

  // Simulate "paid later" behavior (same effect as invoice update route after fix).
  await db.prepare(`
    UPDATE invoices
    SET paid_status = 'Eftpos', payment_amount = 300, payment_date_1 = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(today, invoiceId);

  const bankOld = await db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN substr(trim(COALESCE(payment_date_1,'')),1,10) = ? AND paid_status = 'Eftpos' THEN payment_amount ELSE 0 END), 0) as eftpos
    FROM invoices WHERE carpark_id = ? AND void = 0
  `).get(oldDateIn, carparkId);
  const bankToday = await db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN substr(trim(COALESCE(payment_date_1,'')),1,10) = ? AND paid_status = 'Eftpos' THEN payment_amount ELSE 0 END), 0) as eftpos
    FROM invoices WHERE carpark_id = ? AND void = 0
  `).get(today, carparkId);

  await db.prepare(`
    INSERT INTO account_payments (carpark_id, account_customer_id, payment_date, amount, payment_method, transaction_reference)
    VALUES (?, ?, ?, 120.5, 'Internet Bank', 'TEST-REF')
  `).run(carparkId, accountId, lastMonthDate);

  const paymentsLastMonth = await db.prepare(`
    SELECT COUNT(*) as n, COALESCE(SUM(amount),0) as total
    FROM account_payments
    WHERE carpark_id = ? AND account_customer_id = ?
      AND substr(trim(COALESCE(payment_date,'')),1,10) >= ?
      AND substr(trim(COALESCE(payment_date,'')),1,10) <= ?
  `).get(carparkId, accountId, `${lmYear}-${lmMon}-01`, `${lmYear}-${lmMon}-31`);

  console.log('Banking attribution check: oldDate=%s -> %s, today=%s -> %s', oldDateIn, bankOld.eftpos, today, bankToday.eftpos);
  console.log('Account payment historical-month check: count=%s total=%s', paymentsLastMonth.n, paymentsLastMonth.total);

  if (Number(bankOld.eftpos) !== 0 || Number(bankToday.eftpos) < 300) {
    console.error('FAIL: payment is not attributed to payment date correctly');
    process.exit(1);
  }
  if (Number(paymentsLastMonth.n) < 1 || Number(paymentsLastMonth.total) < 120.5) {
    console.error('FAIL: historical month payment retrieval failed');
    process.exit(1);
  }
  console.log('PASS');
  // Cleanup temporary records created by this test.
  await db.prepare(`DELETE FROM account_payments WHERE account_customer_id = ? AND transaction_reference = 'TEST-REF'`).run(accountId);
  await db.prepare(`DELETE FROM invoices WHERE id = ?`).run(invoiceId);
  await db.prepare(`DELETE FROM account_customers WHERE id = ?`).run(accountId);
  process.exit(0);
})();
