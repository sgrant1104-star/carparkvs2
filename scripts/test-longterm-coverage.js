#!/usr/bin/env node
/**
 * Validates which months a long-term payment is counted in:
 * 1) A normal monthly payment is ONE month — not the whole contract span
 *    (LT7's October payment used to be spread over Aug-Sep).
 * 2) A payment equal to a term total / the contract amount covers that term.
 * 3) A later payment starts AFTER what earlier payments cover, not back at
 *    the contract start (LT19/LT20 used to double-count months).
 * 4) Overlap with existing months is detected.
 * 5) Re-spreading keeps the total and cash date and only moves the months
 *    (LT8: counted from cash date instead of contract start).
 */
const {
  suggestMonthsForPayment, suggestCoverageStart, coverageMonths, findOverlapMonths,
} = require('../src/utils/longtermProration');

let fail = false;
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail = true; } else { console.log('PASS:', msg); } };

(async () => {
  // LT7-style: custom monthly rate, contract spans 3 months — a $137.50 payment is ONE month.
  const lt7 = { contract_start_date: '2026-08-01', expiry_date: '2026-11-01', contract_amount: 137.5 };
  assert(suggestMonthsForPayment(lt7, 137.5) === 3 || suggestMonthsForPayment(lt7, 137.5) === 1, 'sanity: returns a month count');
  const lt7b = { contract_start_date: '2026-08-01', expiry_date: '2026-11-01', contract_amount: 412.5 };
  assert(suggestMonthsForPayment(lt7b, 137.5) === 1, 'monthly payment against a 3-month contract is 1 month (not the contract span)');
  assert(suggestMonthsForPayment(lt7b, 412.5) === 3, 'payment equal to the contract amount covers the contract span');

  const lt = { contract_start_date: '2025-10-14', expiry_date: '2026-10-14', contract_amount: 1650 };
  assert(suggestMonthsForPayment(lt, 1650) === 12, '$1650 covers 12 months');
  assert(suggestMonthsForPayment(lt, 500) === 3, '$500 covers 3 months');
  assert(suggestMonthsForPayment(lt, 200) === 1, 'a plain monthly amount is 1 month');
  assert(suggestMonthsForPayment({}, 0) === 1, 'bad amount is safe');

  // Coverage start
  assert(suggestCoverageStart(lt, [], '2026-03-31') === '2025-10-14', 'first payment starts at the contract start, even if cash arrived later');
  assert(suggestCoverageStart({}, [], '2026-03-31') === '2026-03-31', 'no contract start -> cash date');
  const existing = [{ payment_date: '2026-07-04' }, { payment_date: '2026-08-04' }, { payment_date: '2026-09-04' }];
  assert(suggestCoverageStart({ contract_start_date: '2026-07-04' }, existing, '2026-10-09') === '2026-10-04', 'next payment starts the month after the last one covered');
  assert(suggestCoverageStart({ contract_start_date: '2026-10-01' }, existing, '2026-10-09') === '2026-10-01', 'earlier-term payments before a new contract start are ignored');

  // Overlap
  const months = coverageMonths('2026-07-04', 3);
  assert(months.join() === '2026-07,2026-08,2026-09', 'coverage months for a 3-month spread');
  assert(findOverlapMonths(existing, months).join() === '2026-07,2026-08,2026-09', 'detects months already covered');
  assert(findOverlapMonths(existing, coverageMonths('2026-10-04', 3)).length === 0, 'no overlap when it starts after');
  assert(findOverlapMonths([{ payment_date: '2026-07-04', payment_batch_id: 'b1' }], months, 'b1').length === 0, 'a batch does not overlap itself when re-spread');

  // Re-spread against a real (dev) database, cleaned up afterwards
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();
  const { respreadBatch } = require('../src/utils/ltRespread');
  const { buildProratedPayments } = require('../src/utils/longtermProration');
  const cp = 1;
  const cust = await db.prepare(`INSERT INTO longterm_customers (lt_number, name, carpark_id, contract_start_date, expiry_date, contract_amount) VALUES ('LTZZ', 'TEST COVERAGE', ?, '2025-10-14', '2026-10-14', 1650)`).run(cp);
  const ltId = cust.lastInsertRowid;
  try {
    const orig = buildProratedPayments({ totalAmountExGst: 1650, cashReceivedDate: '2026-03-31', contractStartDate: '2026-03-31', months: 12, baseNotes: null, transactionReference: 'REF1' });
    for (const r of orig.rows) {
      await db.prepare(`INSERT INTO longterm_payments (carpark_id, longterm_customer_id, payment_date, amount_ex_gst, payment_method, transaction_reference, notes, payment_batch_id, cash_received_date) VALUES (?, ?, ?, ?, 'Internet Bank', 'REF1', ?, ?, ?)`)
        .run(cp, ltId, r.payment_date, r.amount_ex_gst, r.notes, orig.batchId, r.cash_received_date);
    }
    const res = await respreadBatch(db, { carparkId: cp, ltId, batchId: orig.batchId, coversFrom: '2025-10-14', months: 12, userName: 'test' });
    const rows = await db.prepare('SELECT * FROM longterm_payments WHERE longterm_customer_id = ? ORDER BY payment_date').all(ltId);
    const sum = Math.round(rows.reduce((s, r) => s + r.amount_ex_gst, 0) * 100) / 100;
    assert(rows.length === 12, 'still 12 rows after re-spread (got ' + rows.length + ')');
    assert(sum === 1650, 'total unchanged at $1650 (got ' + sum + ')');
    assert(String(rows[0].payment_date).slice(0, 10) === '2025-10-14' && String(rows[11].payment_date).slice(0, 10) === '2026-09-14', 'now counted 14 Oct 2025 .. 14 Sep 2026 (got ' + String(rows[0].payment_date).slice(0, 10) + ' .. ' + String(rows[11].payment_date).slice(0, 10) + ')');
    assert(rows.every(r => String(r.cash_received_date).slice(0, 10) === '2026-03-31'), 'cash received date preserved');
    assert(rows.every(r => r.payment_batch_id === orig.batchId), 'same batch id kept');
    const log = await db.prepare(`SELECT COUNT(*) n FROM activity_log WHERE table_name = 'longterm_payments' AND record_id = ? AND action = 'respread'`).get(ltId);
    assert(log.n === 1, 'the change is in the activity log');

    // Single month re-spread
    const one = await respreadBatch(db, { carparkId: cp, ltId, batchId: orig.batchId, coversFrom: '2026-10-01', months: 1, userName: 'test' });
    const rows1 = await db.prepare('SELECT * FROM longterm_payments WHERE longterm_customer_id = ?').all(ltId);
    assert(rows1.length === 1 && rows1[0].amount_ex_gst === 1650 && String(rows1[0].payment_date).slice(0, 10) === '2026-10-01', 'can re-spread to a single month on a chosen date');
  } finally {
    await db.prepare('DELETE FROM longterm_payments WHERE longterm_customer_id = ?').run(ltId);
    await db.prepare('DELETE FROM longterm_customers WHERE id = ?').run(ltId);
    await db.prepare(`DELETE FROM activity_log WHERE table_name = 'longterm_payments' AND record_id = ? AND action = 'respread'`).run(ltId);
  }

  console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(fail ? 1 : 0);
})();
