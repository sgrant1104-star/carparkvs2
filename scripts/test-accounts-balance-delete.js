#!/usr/bin/env node
/**
 * Validates lifetime balance on account list query + payment delete.
 * Run: node scripts/test-accounts-balance-delete.js
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();
  const carparkId = 1;

  const ac = await db.prepare(`INSERT INTO account_customers (company_name, carpark_id, active) VALUES (?, ?, 1)`)
    .run(`BAL-TEST-${Date.now()}`, carparkId);
  const aid = ac.lastInsertRowid;

  await db.prepare(`
    INSERT INTO invoices (invoice_number, carpark_id, account_customer_id, first_name, last_name, date_in, total_price, paid_status, void)
    VALUES (?, ?, ?, 'X','Y', '2026-03-10', 45.90, 'OnAcc', 0)
  `).run(800000 + (Date.now() % 100000), carparkId, aid);

  await db.prepare(`
    INSERT INTO account_payments (carpark_id, account_customer_id, payment_date, amount, payment_method)
    VALUES (?, ?, '2026-03-28', 20, 'Internet Bank')
  `).run(carparkId, aid);

  const row = await db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(COALESCE(i.total_price,0)),0) FROM invoices i
       WHERE i.account_customer_id = a.id AND i.carpark_id = a.carpark_id AND i.void = 0) AS lifetime_billed,
      (SELECT COALESCE(SUM(p.amount),0) FROM account_payments p
       WHERE p.account_customer_id = a.id AND p.carpark_id = a.carpark_id) AS lifetime_paid
    FROM account_customers a WHERE a.id = ?
  `).get(aid);

  const bal = Math.round(((parseFloat(row.lifetime_billed) || 0) - (parseFloat(row.lifetime_paid) || 0)) * 100) / 100;
  if (Math.abs(bal - 25.9) > 0.02) {
    console.error('FAIL balance', bal);
    process.exit(1);
  }

  const pay = await db.prepare(`SELECT id FROM account_payments WHERE account_customer_id = ?`).get(aid);
  await db.prepare(`DELETE FROM account_payments WHERE id = ?`).run(pay.id);

  const row2 = await db.prepare(`
    SELECT (SELECT COALESCE(SUM(p.amount),0) FROM account_payments p WHERE p.account_customer_id = ?) AS p
  `).get(aid);
  if (Number(row2.p) !== 0) {
    console.error('FAIL delete');
    process.exit(1);
  }

  await db.prepare(`DELETE FROM invoices WHERE account_customer_id = ?`).run(aid);
  await db.prepare(`DELETE FROM account_customers WHERE id = ?`).run(aid);
  console.log('PASS');
  process.exit(0);
})();
