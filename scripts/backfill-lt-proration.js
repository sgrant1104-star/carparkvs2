#!/usr/bin/env node
/**
 * ⚠️  DO NOT run this against a live/production deployment via a separate
 * console session — the app keeps its database in memory and periodically
 * flushes it to disk; a standalone script has its OWN independent copy, and
 * whichever process saves last silently overwrites the other's changes.
 * On production, use the Admin page's "Data Backfills" panel instead (runs
 * safely inside the live server process). This script is fine for local
 * development against a database file the live server isn't also using.
 *
 * One-time backfill: retroactively spreads old long-term prepayments across
 * months, for payments made BEFORE the proration feature existed.
 *
 * How it finds candidates: every payment created through the current system
 * gets a `payment_batch_id` (even single-month ones — see longterm.js). Old
 * payments predating this feature have `payment_batch_id IS NULL`. That's
 * the reliable, unambiguous marker this script uses — nothing else is
 * touched.
 *
 * For each candidate, it re-runs the SAME detection logic used for new
 * payments (inferContractMonths) to decide whether the amount looks like a
 * multi-month prepay (e.g. $1650 ≈ 12 months) or a normal single month. Only
 * multi-month matches get changed — normal single-month payments are left
 * completely alone.
 *
 * ⚠️  THIS REWRITES WHICH MONTH OLD REVENUE IS RECOGNISED IN. That's exactly
 * the point (correcting historical monthly reports to reflect accrual
 * instead of cash-on-receipt), but it means past End of Day / Reports
 * figures for those months WILL change after this runs. Review the dry run
 * output carefully before applying.
 *
 * Usage:
 *   node scripts/backfill-lt-proration.js            → DRY RUN (default, no DB writes)
 *   node scripts/backfill-lt-proration.js --apply     → actually applies the changes
 *
 * Safe to re-run: once a row is processed, its replacement rows have a
 * payment_batch_id, so they will never be picked up again by a later run.
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();
  const { inferContractMonths, buildProratedPayments } = require('../src/utils/longtermProration');
  const { logActivity } = require('../src/utils/audit');

  const APPLY = process.argv.includes('--apply');
  console.log(APPLY ? '=== APPLY MODE — this WILL write changes ===\n' : '=== DRY RUN — no changes will be made (pass --apply to actually run it) ===\n');

  const candidates = await db.prepare(`
    SELECT lp.*, lc.name, lc.lt_number, lc.contract_start_date, lc.expiry_date, lc.contract_amount, lc.carpark_id as lt_carpark_id
    FROM longterm_payments lp
    JOIN longterm_customers lc ON lc.id = lp.longterm_customer_id
    WHERE lp.payment_batch_id IS NULL
    ORDER BY lp.longterm_customer_id, lp.payment_date
  `).all();

  console.log(`Found ${candidates.length} payment(s) with no batch id (candidates for review).\n`);

  let toSpread = 0;
  let leftAlone = 0;
  let errors = 0;

  for (const row of candidates) {
    const customer = {
      contract_start_date: row.contract_start_date,
      expiry_date: row.expiry_date,
      contract_amount: row.contract_amount,
    };
    const months = inferContractMonths(customer, row.amount_ex_gst);

    if (months <= 1) {
      leftAlone++;
      continue; // looks like a normal single-month payment — leave it exactly as-is
    }

    toSpread++;
    const cashReceivedDate = row.cash_received_date || row.payment_date;
    const proration = buildProratedPayments({
      totalAmountExGst: row.amount_ex_gst,
      cashReceivedDate,
      contractStartDate: row.contract_start_date || cashReceivedDate,
      months,
      transactionReference: row.transaction_reference,
      baseNotes: row.notes,
    });

    console.log(`${row.lt_number} — ${row.name}: payment #${row.id} of $${Number(row.amount_ex_gst).toFixed(2)} (dated ${String(row.payment_date).slice(0, 10)})`);
    console.log(`  → looks like a ${months}-month prepay. Would spread into:`);
    for (const r of proration.rows) {
      console.log(`     ${r.payment_date}: $${r.amount_ex_gst.toFixed(2)}`);
    }
    console.log('');

    if (APPLY) {
      try {
        for (const r of proration.rows) {
          await db.prepare(`
            INSERT INTO longterm_payments
              (carpark_id, longterm_customer_id, payment_date, amount_ex_gst, payment_method, transaction_reference, payment_batch_id, cash_received_date, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            row.lt_carpark_id, row.longterm_customer_id, r.payment_date, r.amount_ex_gst,
            row.payment_method, row.transaction_reference, r.payment_batch_id, r.cash_received_date, r.notes
          );
        }
        // Only delete the old row after every replacement row inserted successfully.
        await db.prepare('DELETE FROM longterm_payments WHERE id = ?').run(row.id);

        await logActivity(db, {
          carparkId: row.lt_carpark_id, tableName: 'longterm_payments', recordId: row.longterm_customer_id, action: 'backfill_proration',
          before: { old_payment_id: row.id, amount_ex_gst: row.amount_ex_gst, payment_date: row.payment_date },
          after: { months, rows: proration.rows },
          notes: `Backfill: spread old payment #${row.id} across ${months} months`,
        });
      } catch (err) {
        errors++;
        console.error(`  ERROR applying this one — left untouched: ${err.message}`);
      }
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Left alone (single-month, no change needed): ${leftAlone}`);
  console.log(`${APPLY ? 'Spread' : 'Would spread'}: ${toSpread}`);
  if (APPLY) console.log(`Errors: ${errors}`);
  if (!APPLY && toSpread > 0) {
    console.log(`\nNothing was changed. Review the list above, then re-run with --apply to actually make these changes.`);
  }

  process.exit(errors > 0 ? 1 : 0);
})().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
