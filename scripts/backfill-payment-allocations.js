#!/usr/bin/env node
/**
 * One-time backfill: allocates existing account_payments rows that predate
 * the payment_allocations feature (i.e. every payment recorded before this
 * deploy). Without this, the new "outstanding" figures (Dashboard, Accounts
 * page, month-end emails) will look artificially high for any account that
 * paid something before this feature existed — the old payment is real
 * money that was received, it just isn't linked to a specific invoice yet.
 *
 * This processes each account's payments oldest-first, allocating FIFO
 * against that account's invoices oldest-first — exactly the same logic
 * allocateAccountPayment() uses for new payments — so the end result is
 * "as if allocation had existed from day one."
 *
 * SAFE TO RE-RUN: any payment that already has at least one allocation row
 * is skipped, so running this twice will not double-allocate anything.
 *
 * Usage:  node scripts/backfill-payment-allocations.js
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();
  const { allocateAccountPayment } = require('../src/utils/paymentAllocation');

  const accounts = await db.prepare('SELECT * FROM account_customers').all();
  console.log(`Found ${accounts.length} account customer(s) to check.\n`);

  let totalAllocated = 0;
  let totalSkippedAlreadyDone = 0;
  let totalPaymentsProcessed = 0;

  for (const account of accounts) {
    const carparkId = account.carpark_id || 1;
    const payments = await db.prepare(`
      SELECT * FROM account_payments
      WHERE carpark_id = ? AND account_customer_id = ?
      ORDER BY payment_date ASC, id ASC
    `).all(carparkId, account.id);

    if (payments.length === 0) continue;

    let accountAllocatedCount = 0;
    for (const payment of payments) {
      const existingAlloc = await db.prepare(`
        SELECT COUNT(*) as n FROM payment_allocations
        WHERE carpark_id = ? AND payment_source = 'account' AND payment_id = ?
      `).get(carparkId, payment.id);

      if (existingAlloc.n > 0) {
        totalSkippedAlreadyDone++;
        continue;
      }

      const result = await allocateAccountPayment(db, {
        carparkId, accountCustomerId: account.id, paymentId: payment.id, amount: payment.amount,
      });
      totalPaymentsProcessed++;
      if (result.splits.length > 0) {
        accountAllocatedCount++;
        totalAllocated += result.splits.reduce((s, x) => s + x.amount_allocated, 0);
      }
    }

    if (accountAllocatedCount > 0) {
      console.log(`${account.company_name}: allocated ${accountAllocatedCount} payment(s).`);
    }
  }

  console.log(`\nDone.`);
  console.log(`Payments newly processed: ${totalPaymentsProcessed}`);
  console.log(`Payments already allocated (skipped): ${totalSkippedAlreadyDone}`);
  console.log(`Total $ allocated: $${totalAllocated.toFixed(2)}`);
  process.exit(0);
})().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
