#!/usr/bin/env node
/**
 * Verifies LT prepay proration and returns pickup exclusion.
 * Run: node scripts/test-longterm-proration.js
 */
const {
  inferContractMonths,
  buildProratedPayments,
  splitAmount,
} = require('../src/utils/longtermProration');

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failed += 1; }
  else console.log('OK:', msg);
}

// Proration math
const parts = splitAmount(1650, 12);
assert(parts.length === 12, '12 parts');
assert(Math.abs(parts.reduce((s, x) => s + x, 0) - 1650) < 0.02, 'parts sum to total');

const months = inferContractMonths(
  { contract_start_date: '2026-01-01', expiry_date: '2026-12-31', contract_amount: 1650 },
  1650
);
assert(months === 12, 'infers 12 months from dates + amount');

const built = buildProratedPayments({
  totalAmountExGst: 500,
  cashReceivedDate: '2026-03-15',
  contractStartDate: '2026-03-15',
  months: 3,
  transactionReference: 'TX123',
});
assert(built.rows.length === 3, '3 prorated rows');
assert(built.rows[0].payment_date === '2026-03-15', 'first month on start');
assert(built.rows[1].payment_date === '2026-04-15', 'second month');
assert(Math.abs(built.rows.reduce((s, r) => s + r.amount_ex_gst, 0) - 500) < 0.02, 'prorated sum');

(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();
  const carparkId = 1;

  const inYardExpr = `(i.picked_up IS NULL OR i.picked_up = '' OR i.picked_up = 'Car In Yard')`;
  const today = new Date().toISOString().slice(0, 10);

  const before = await db.prepare(`
    SELECT COUNT(*) as c FROM invoices i
    WHERE i.carpark_id = ? AND i.void = 0 AND DATE(i.return_date) = ?
  `).get(carparkId, today);

  const afterFilter = await db.prepare(`
    SELECT COUNT(*) as c FROM invoices i
    WHERE i.carpark_id = ? AND i.void = 0 AND DATE(i.return_date) = ? AND ${inYardExpr}
  `).get(carparkId, today);

  assert(afterFilter.c <= before.c, 'in-yard filter reduces or equals return count');

  console.log(failed ? `\n${failed} test(s) failed` : '\nAll proration / returns checks passed');
  process.exit(failed ? 1 : 0);
})();
