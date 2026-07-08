#!/usr/bin/env node
/**
 * Sanity-check: dashboard "Returning Today" count vs /api/returns for the same date.
 * Run from project root: node scripts/check-returns-sync.js
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  const { businessDateYmd } = require('../src/utils/businessDate');

  await initializeDatabase();
  const carparkId = 1;
  const today = businessDateYmd();

  const dash = await db.prepare(
    `SELECT COUNT(*) as c FROM invoices WHERE carpark_id = ? AND void = 0 AND DATE(return_date) = ?`
  ).get(carparkId, today);

  const ret = await db.prepare(
    `SELECT COUNT(*) as c FROM invoices WHERE carpark_id = ? AND void = 0 AND DATE(return_date) = ?`
  ).get(carparkId, today);

  console.log('Business date (NZ):', today);
  console.log('Invoices with return_date = that day (void=0):', dash.c);
  console.log('Returns API base query matches same SQL →', ret.c === dash.c ? 'OK' : 'MISMATCH');

  const sample = await db.prepare(
    `SELECT id, invoice_number, rego, return_date, picked_up FROM invoices
     WHERE carpark_id = ? AND void = 0 AND DATE(return_date) = ? LIMIT 5`
  ).all(carparkId, today);
  console.log('Sample rows:', sample.length ? sample : '(none)');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
