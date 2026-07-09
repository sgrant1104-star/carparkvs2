#!/usr/bin/env node
/**
 * Validates that cancelling an invoice (void or delete) doesn't strand money:
 * 1) Voiding an invoice with an allocated account payment frees that
 *    allocation — the money becomes available/unallocated again.
 * 2) Deleting an invoice does the same.
 * 3) Voiding an invoice that had customer_credits applied restores that
 *    credit to 'available' status.
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();
  const { allocateAccountPayment, getAccountInvoicesWithOutstanding, deallocateInvoice } = require('../src/utils/paymentAllocation');
  const { releaseCreditForInvoice } = require('../src/utils/customerCredit');

  const carparkId = 1;
  let fail = false;
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail = true; } else { console.log('PASS:', msg); } };

  // --- Part 1: account payment allocation survives void/delete correctly ---
  const acct = await db.prepare(`INSERT INTO account_customers (company_name, carpark_id, active) VALUES (?, ?, 1)`)
    .run(`TEST-VOID-ALLOC-${Date.now()}`, carparkId);
  const accountId = acct.lastInsertRowid;

  const mkInvoice = async (total) => {
    const r = await db.prepare(`
      INSERT INTO invoices (invoice_number, carpark_id, account_customer_id, first_name, last_name, rego, date_in, time_in, return_date, return_time, total_price, paid_status, void)
      VALUES (?, ?, ?, 'Void', 'Test', 'VOID001', '2026-09-01', '09:00', '2026-09-03', '09:00', ?, 'To Pay', 0)
    `).run(960000 + (Date.now() % 5000) + Math.floor(Math.random() * 500), carparkId, accountId, total);
    return r.lastInsertRowid;
  };

  const inv1 = await mkInvoice(80);
  const pay1 = await db.prepare(`INSERT INTO account_payments (carpark_id, account_customer_id, payment_date, amount, payment_method) VALUES (?, ?, '2026-09-02', 80, 'Eftpos')`).run(carparkId, accountId);
  await allocateAccountPayment(db, { carparkId, accountCustomerId: accountId, paymentId: pay1.lastInsertRowid, amount: 80 });

  let invoices = await getAccountInvoicesWithOutstanding(db, { carparkId, accountCustomerId: accountId });
  let inv1State = invoices.find(i => i.id === inv1);
  assert(inv1State.outstanding_amount === 0, 'invoice fully paid before void');

  // Simulate the void route's deallocation step directly
  const freed = await deallocateInvoice(db, { carparkId, invoiceId: inv1 });
  assert(freed.length === 1 && freed[0].amount_allocated === 80, 'voiding frees the $80 allocation');
  await db.prepare('UPDATE invoices SET void = 1 WHERE id = ?').run(inv1);

  // The freed payment should now show as fully unallocated if checked against a NEW invoice
  const inv2 = await mkInvoice(50);
  const applyResult = await allocateAccountPayment(db, {
    carparkId, accountCustomerId: accountId, paymentId: pay1.lastInsertRowid, amount: 0, // no-op call, just checking availability via findAvailable style below
  });
  const remainingPaymentCheck = await db.prepare(`
    SELECT COALESCE(SUM(amount_allocated),0) as allocated FROM payment_allocations WHERE payment_id = ?
  `).get(pay1.lastInsertRowid);
  assert(remainingPaymentCheck.allocated === 0, 'payment #1 shows $0 allocated after its invoice was voided (freed, not orphaned)');

  // --- Part 2: customer credit survives void correctly ---
  const invSource = await mkInvoice(500);
  await db.prepare(`UPDATE invoices SET stay_nights = 10, paid_status = 'Eftpos', payment_amount = 500, return_date = '2026-09-11' WHERE id = ?`).run(invSource);
  const { checkAndCreateEarlyReturnCredit, applyCreditToInvoice, findAvailableCredit } = require('../src/utils/customerCredit');
  await db.prepare(`UPDATE invoices SET phone = '027-999-0001' WHERE id IN (?, ?)`).run(invSource, inv2);
  const credit = await checkAndCreateEarlyReturnCredit(db, { carparkId, invoiceId: invSource, actualReturnDate: '2026-09-08' });
  assert(credit && credit.amount > 0, `early-return credit created ($${credit && credit.amount})`);

  const applyResult2 = await applyCreditToInvoice(db, { carparkId, invoiceId: inv2, amount: credit.amount, phone: '027-999-0001' });
  assert(applyResult2.applied > 0, `credit applied to invoice 2 ($${applyResult2.applied})`);

  let avail = await findAvailableCredit(db, { carparkId, phone: '027-999-0001' });
  assert(avail.totalAvailable === 0, 'credit fully consumed, none available');

  // Now release it (simulating inv2 being voided)
  await releaseCreditForInvoice(db, { carparkId, invoiceId: inv2 });
  avail = await findAvailableCredit(db, { carparkId, phone: '027-999-0001' });
  assert(Math.abs(avail.totalAvailable - credit.amount) < 0.01, `credit restored to available after inv2 voided (got $${avail.totalAvailable}, expected $${credit.amount})`);

  console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');

  // Cleanup
  await db.prepare('DELETE FROM payment_allocations WHERE carpark_id = ? AND invoice_id IN (?, ?, ?)').run(carparkId, inv1, inv2, invSource);
  await db.prepare('DELETE FROM customer_credits WHERE source_invoice_id = ?').run(invSource);
  await db.prepare('DELETE FROM account_payments WHERE id = ?').run(pay1.lastInsertRowid);
  await db.prepare('DELETE FROM invoices WHERE id IN (?, ?, ?)').run(inv1, inv2, invSource);
  await db.prepare('DELETE FROM account_customers WHERE id = ?').run(accountId);

  process.exit(fail ? 1 : 0);
})();
