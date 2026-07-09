#!/usr/bin/env node
/**
 * READ-ONLY diagnostic — makes no changes. Shows exactly where a given
 * account's payments have been allocated, across their FULL invoice
 * history (not filtered to any one month), so you can see the truth
 * instead of guessing from a month-filtered statement view.
 *
 * Usage:
 *   node scripts/check-account-allocation.js "CTM"
 *   node scripts/check-account-allocation.js 14
 * (accepts either part of the company name, or a numeric account id)
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();
  const { getAccountInvoicesWithOutstanding } = require('../src/utils/paymentAllocation');

  const query = process.argv[2];
  if (!query) {
    console.error('Usage: node scripts/check-account-allocation.js "<company name or id>"');
    process.exit(1);
  }

  const isId = /^\d+$/.test(query);
  const accounts = isId
    ? await db.prepare('SELECT * FROM account_customers WHERE id = ?').all(query)
    : await db.prepare('SELECT * FROM account_customers WHERE company_name LIKE ?').all(`%${query}%`);

  if (accounts.length === 0) {
    console.log('No matching account found.');
    process.exit(0);
  }

  for (const account of accounts) {
    console.log(`\n=== ${account.company_name} (id ${account.id}, carpark ${account.carpark_id}) ===\n`);

    const invoices = await getAccountInvoicesWithOutstanding(db, {
      carparkId: account.carpark_id, accountCustomerId: account.id,
    });

    if (invoices.length === 0) {
      console.log('  No invoices at all for this account.');
      continue;
    }

    let totalInvoiced = 0, totalAllocated = 0, totalOutstanding = 0;
    for (const inv of invoices) {
      totalInvoiced += parseFloat(inv.total_price) || 0;
      totalAllocated += inv.allocated_amount;
      totalOutstanding += inv.outstanding_amount;
      const flag = inv.allocated_amount > 0 ? '  <- has allocation' : '';
      console.log(
        `  ${String(inv.date_in).slice(0, 10)}  #${inv.invoice_number}  total $${Number(inv.total_price).toFixed(2).padStart(8)}  ` +
        `allocated $${inv.allocated_amount.toFixed(2).padStart(8)}  outstanding $${inv.outstanding_amount.toFixed(2).padStart(8)}  ` +
        `[${inv.invoice_payment_status}]${flag}`
      );
    }

    console.log(`\n  TOTALS across ALL invoices (all-time, not just one month):`);
    console.log(`    Invoiced:    $${totalInvoiced.toFixed(2)}`);
    console.log(`    Allocated:   $${totalAllocated.toFixed(2)}`);
    console.log(`    Outstanding: $${totalOutstanding.toFixed(2)}`);

    const payments = await db.prepare(`
      SELECT * FROM account_payments WHERE carpark_id = ? AND account_customer_id = ? ORDER BY payment_date ASC
    `).all(account.carpark_id, account.id);
    console.log(`\n  Payments on file (${payments.length}):`);
    for (const p of payments) {
      const allocRows = await db.prepare(`
        SELECT pa.amount_allocated, i.invoice_number, i.date_in
        FROM payment_allocations pa JOIN invoices i ON i.id = pa.invoice_id
        WHERE pa.payment_source = 'account' AND pa.payment_id = ?
      `).all(p.id);
      const allocSum = allocRows.reduce((s, r) => s + r.amount_allocated, 0);
      console.log(`    ${String(p.payment_date).slice(0, 10)}  $${Number(p.amount).toFixed(2)}  (${p.payment_method || 'no method'}) — allocated to: ${
        allocRows.length === 0 ? 'NOTHING (unallocated credit)' : allocRows.map(r => `#${r.invoice_number} ($${r.amount_allocated.toFixed(2)})`).join(', ')
      }`);
    }
  }

  process.exit(0);
})().catch(err => {
  console.error('Check failed:', err);
  process.exit(1);
});
