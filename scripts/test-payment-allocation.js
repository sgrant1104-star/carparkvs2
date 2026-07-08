#!/usr/bin/env node
/**
 * Validates payment_allocations:
 * 1) A payment smaller than total outstanding allocates FIFO (oldest invoice first).
 * 2) A payment that overpays the oldest invoice spills into the next-oldest.
 * 3) Per-invoice outstanding is correct after allocation.
 * 4) Deleting a payment removes its allocations and restores outstanding.
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();
  const { allocateAccountPayment, deallocatePayment, getAccountInvoicesWithOutstanding } = require('../src/utils/paymentAllocation');

  const carparkId = 1;
  const today = new Date().toISOString().slice(0, 10);

  const acct = await db.prepare(`INSERT INTO account_customers (company_name, carpark_id, active) VALUES (?, ?, 1)`)
    .run(`TEST-ALLOC-${Date.now()}`, carparkId);
  const accountId = acct.lastInsertRowid;

  const mkInvoice = async (dateIn, total) => {
    const r = await db.prepare(`
      INSERT INTO invoices (
        invoice_number, carpark_id, account_customer_id, first_name, last_name, rego,
        date_in, time_in, return_date, return_time, total_price, paid_status, payment_amount, void
      ) VALUES (?, ?, ?, 'T', 'Customer', 'TST999', ?, '10:00', ?, '10:00', ?, 'To Pay', 0, 0)
    `).run(950000 + (Date.now() % 40000) + Math.floor(Math.random() * 1000), carparkId, accountId, dateIn, dateIn, total);
    return r.lastInsertRowid;
  };

  // Three invoices, oldest first: $100 (Jan 1), $150 (Jan 5), $200 (Jan 10)
  const inv1 = await mkInvoice('2026-01-01', 100);
  const inv2 = await mkInvoice('2026-01-05', 150);
  const inv3 = await mkInvoice('2026-01-10', 200);

  let fail = false;
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail = true; } else { console.log('PASS:', msg); } };

  // Payment 1: $120 — should fully cover inv1 ($100) and partially cover inv2 ($20 of $150)
  const pay1 = await db.prepare(`INSERT INTO account_payments (carpark_id, account_customer_id, payment_date, amount, payment_method) VALUES (?, ?, ?, ?, ?)`)
    .run(carparkId, accountId, today, 120, 'Eftpos');
  const alloc1 = await allocateAccountPayment(db, { carparkId, accountCustomerId: accountId, paymentId: pay1.lastInsertRowid, amount: 120 });

  assert(alloc1.splits.length === 2, `payment 1 splits across 2 invoices (got ${alloc1.splits.length})`);
  assert(alloc1.splits[0].invoice_id === inv1 && alloc1.splits[0].amount_allocated === 100, 'payment 1 fully covers oldest invoice (inv1, $100)');
  assert(alloc1.splits[1].invoice_id === inv2 && alloc1.splits[1].amount_allocated === 20, 'payment 1 spills $20 into inv2');
  assert(alloc1.unallocated === 0, 'payment 1 fully allocated, nothing left over');

  let invoices = await getAccountInvoicesWithOutstanding(db, { carparkId, accountCustomerId: accountId });
  const inv1State = invoices.find(i => i.id === inv1);
  const inv2State = invoices.find(i => i.id === inv2);
  const inv3State = invoices.find(i => i.id === inv3);
  assert(inv1State.outstanding_amount === 0 && inv1State.invoice_payment_status === 'Paid', 'inv1 now fully paid');
  assert(inv2State.outstanding_amount === 130 && inv2State.invoice_payment_status === 'Partial', 'inv2 partially paid ($130 outstanding of $150)');
  assert(inv3State.outstanding_amount === 200 && inv3State.invoice_payment_status === 'Outstanding', 'inv3 untouched ($200 outstanding)');

  // Payment 2: $500 (overpay) — covers rest of inv2 ($130) + all of inv3 ($200), $170 left unallocated (credit)
  const pay2 = await db.prepare(`INSERT INTO account_payments (carpark_id, account_customer_id, payment_date, amount, payment_method) VALUES (?, ?, ?, ?, ?)`)
    .run(carparkId, accountId, today, 500, 'Internet Bank');
  const alloc2 = await allocateAccountPayment(db, { carparkId, accountCustomerId: accountId, paymentId: pay2.lastInsertRowid, amount: 500 });
  assert(alloc2.unallocated === 170, `overpayment leaves $170 unallocated as credit (got ${alloc2.unallocated})`);

  invoices = await getAccountInvoicesWithOutstanding(db, { carparkId, accountCustomerId: accountId });
  const allPaid = invoices.every(i => i.outstanding_amount === 0);
  assert(allPaid, 'all three invoices fully paid after payment 2');

  // Delete payment 2 — allocations should be removed, outstanding restored
  await deallocatePayment(db, { carparkId, paymentSource: 'account', paymentId: pay2.lastInsertRowid });
  await db.prepare('DELETE FROM account_payments WHERE id = ?').run(pay2.lastInsertRowid);
  invoices = await getAccountInvoicesWithOutstanding(db, { carparkId, accountCustomerId: accountId });
  const inv3AfterDelete = invoices.find(i => i.id === inv3);
  assert(inv3AfterDelete.outstanding_amount === 200, 'deleting payment 2 restores inv3 outstanding to $200');

  console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');

  // Cleanup
  await db.prepare('DELETE FROM payment_allocations WHERE carpark_id = ? AND invoice_id IN (?, ?, ?)').run(carparkId, inv1, inv2, inv3);
  await db.prepare('DELETE FROM account_payments WHERE id IN (?, ?)').run(pay1.lastInsertRowid, pay2.lastInsertRowid);
  await db.prepare('DELETE FROM invoices WHERE id IN (?, ?, ?)').run(inv1, inv2, inv3);
  await db.prepare('DELETE FROM account_customers WHERE id = ?').run(accountId);

  process.exit(fail ? 1 : 0);
})();
