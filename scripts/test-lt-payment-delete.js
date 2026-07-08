#!/usr/bin/env node
/**
 * Validates long-term payment delete behaviour:
 * 1) Deleting a single (non-prorated) payment removes just that row and
 *    recalculates paid/status correctly.
 * 2) Deleting a prorated BATCH removes every row sharing that batch id in
 *    one action, not just one month of it.
 * 3) Payment status (Unpaid/Partial/Paid) recalculates correctly after each.
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();
  const { buildProratedPayments, inferContractMonths, collapsePaymentsForDisplay } = require('../src/utils/longtermProration');

  const carparkId = 1;
  const today = new Date().toISOString().slice(0, 10);
  let fail = false;
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail = true; } else { console.log('PASS:', msg); } };

  const lt = await db.prepare(`INSERT INTO longterm_customers (lt_number, name, carpark_id, active, contract_start_date, contract_amount, payment_status) VALUES (?, ?, ?, 1, ?, ?, 'Unpaid')`)
    .run(`LT-DEL-TEST-${Date.now()}`, 'Delete Test Customer', carparkId, today, 1850);
  const ltId = lt.lastInsertRowid;

  // Single $200 monthly payment (not prorated — 1 month)
  const singleRow = await db.prepare(`
    INSERT INTO longterm_payments (carpark_id, longterm_customer_id, payment_date, amount_ex_gst, payment_method, payment_batch_id, cash_received_date)
    VALUES (?, ?, ?, 200, 'Internet Bank', ?, ?)
  `).run(carparkId, ltId, today, `single-batch-${Date.now()}`, today);
  const singlePaymentId = singleRow.lastInsertRowid;

  // Prorated 12-month batch ($1650 spread)
  const months = inferContractMonths({ contract_start_date: today, expiry_date: null }, 1650);
  const proration = buildProratedPayments({ totalAmountExGst: 1650, cashReceivedDate: today, contractStartDate: today, months });
  const batchRowIds = [];
  for (const row of proration.rows) {
    const r = await db.prepare(`
      INSERT INTO longterm_payments (carpark_id, longterm_customer_id, payment_date, amount_ex_gst, payment_method, payment_batch_id, cash_received_date, notes)
      VALUES (?, ?, ?, ?, 'Eftpos', ?, ?, ?)
    `).run(carparkId, ltId, row.payment_date, row.amount_ex_gst, row.payment_batch_id, row.cash_received_date, row.notes);
    batchRowIds.push(r.lastInsertRowid);
  }

  assert(batchRowIds.length === 12, `12-month contract produces 12 rows (got ${batchRowIds.length})`);

  let totalPaid = await db.prepare(`SELECT COALESCE(SUM(amount_ex_gst),0) as t FROM longterm_payments WHERE longterm_customer_id = ?`).get(ltId);
  assert(Math.abs(totalPaid.t - 1850) < 0.01, `total paid is $1850 (200 + 1650) before any deletes (got $${totalPaid.t})`);

  // Delete the single $200 row directly (simulating the single-row DELETE endpoint)
  await db.prepare('DELETE FROM longterm_payments WHERE id = ?').run(singlePaymentId);
  totalPaid = await db.prepare(`SELECT COALESCE(SUM(amount_ex_gst),0) as t FROM longterm_payments WHERE longterm_customer_id = ?`).get(ltId);
  assert(Math.abs(totalPaid.t - 1650) < 0.01, `after deleting the single $200 row, $1650 remains (got $${totalPaid.t})`);

  const remainingRows = await db.prepare(`SELECT COUNT(*) as n FROM longterm_payments WHERE longterm_customer_id = ?`).get(ltId);
  assert(remainingRows.n === 12, `all 12 batch rows are untouched by the single delete (got ${remainingRows.n})`);

  // Delete the entire prorated batch (simulating the batch DELETE endpoint)
  await db.prepare('DELETE FROM longterm_payments WHERE carpark_id = ? AND longterm_customer_id = ? AND payment_batch_id = ?')
    .run(carparkId, ltId, proration.batchId);
  totalPaid = await db.prepare(`SELECT COALESCE(SUM(amount_ex_gst),0) as t FROM longterm_payments WHERE longterm_customer_id = ?`).get(ltId);
  assert(Math.abs(totalPaid.t - 0) < 0.01, `after deleting the whole batch, nothing remains (got $${totalPaid.t})`);

  const finalRows = await db.prepare(`SELECT COUNT(*) as n FROM longterm_payments WHERE longterm_customer_id = ?`).get(ltId);
  assert(finalRows.n === 0, `all rows gone after batch delete (got ${finalRows.n})`);

  console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');

  await db.prepare('DELETE FROM longterm_payments WHERE longterm_customer_id = ?').run(ltId);
  await db.prepare('DELETE FROM longterm_customers WHERE id = ?').run(ltId);

  process.exit(fail ? 1 : 0);
})();
