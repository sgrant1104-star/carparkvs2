#!/usr/bin/env node
/**
 * Validates that an invoice paid DIRECTLY (Eftpos/Cash at pickup) is
 * correctly treated as settled — not just invoices paid via the account's
 * bulk payment/allocation process. Reproduces the exact real-world case
 * that exposed this bug: an account invoice marked paid_status='Eftpos'
 * with a real payment_amount, but never mentioned in payment_allocations
 * (because it was paid on the spot, not through a later bulk payment).
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();
  const { getAccountInvoicesWithOutstanding, getInvoiceOutstanding, allocateAccountPayment } = require('../src/utils/paymentAllocation');

  const carparkId = 1;
  let fail = false;
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail = true; } else { console.log('PASS:', msg); } };

  const acct = await db.prepare(`INSERT INTO account_customers (company_name, carpark_id, active) VALUES (?, ?, 1)`)
    .run(`TEST-DIRECT-PAY-${Date.now()}`, carparkId);
  const accountId = acct.lastInsertRowid;
  const createdInvoiceIds = [];

  // Reproduces Adelice's exact case: $48 invoice, paid_status='Eftpos', payment_amount=48, NO account_payments/allocations at all.
  const directPaid = await db.prepare(`
    INSERT INTO invoices (invoice_number, carpark_id, account_customer_id, first_name, last_name, rego, date_in, time_in, return_date, return_time,
      total_price, paid_status, payment_amount, void)
    VALUES (?, ?, ?, 'Adelice', 'Test', 'ESKPE', '2026-06-22', '09:00', '2026-06-24', '09:00', 48, 'Eftpos', 48, 0)
  `).run(980000 + (Date.now() % 5000), carparkId, accountId);
  createdInvoiceIds.push(directPaid.lastInsertRowid);

  // A genuinely OnAcc, unpaid invoice for comparison — must still show as outstanding.
  const onAccUnpaid = await db.prepare(`
    INSERT INTO invoices (invoice_number, carpark_id, account_customer_id, first_name, last_name, rego, date_in, time_in, return_date, return_time,
      total_price, paid_status, payment_amount, void)
    VALUES (?, ?, ?, 'Other', 'Test', 'OTH001', '2026-06-25', '09:00', '2026-06-27', '09:00', 60, 'OnAcc', 0, 0)
  `).run(980000 + (Date.now() % 5000) + 1, carparkId, accountId);
  createdInvoiceIds.push(onAccUnpaid.lastInsertRowid);

  // A partially-paid case: $100 invoice, $40 paid directly via Cash, $60 still owing.
  const partialDirect = await db.prepare(`
    INSERT INTO invoices (invoice_number, carpark_id, account_customer_id, first_name, last_name, rego, date_in, time_in, return_date, return_time,
      total_price, paid_status, payment_amount, void)
    VALUES (?, ?, ?, 'Partial', 'Test', 'PART001', '2026-06-26', '09:00', '2026-06-28', '09:00', 100, 'Cash', 40, 0)
  `).run(980000 + (Date.now() % 5000) + 2, carparkId, accountId);
  createdInvoiceIds.push(partialDirect.lastInsertRowid);

  const invoices = await getAccountInvoicesWithOutstanding(db, { carparkId, accountCustomerId: accountId });
  const adelice = invoices.find(i => i.id === directPaid.lastInsertRowid);
  const other = invoices.find(i => i.id === onAccUnpaid.lastInsertRowid);
  const partial = invoices.find(i => i.id === partialDirect.lastInsertRowid);

  assert(adelice.outstanding_amount === 0, `directly-paid $48 Eftpos invoice shows $0 outstanding (got $${adelice.outstanding_amount}) — this is the exact bug from the screenshot`);
  assert(adelice.allocated_amount === 48, `directly-paid invoice shows $48 paid (got $${adelice.allocated_amount})`);
  assert(other.outstanding_amount === 60, `genuinely unpaid OnAcc invoice still correctly shows $60 outstanding (got $${other.outstanding_amount})`);
  assert(partial.outstanding_amount === 60, `partially direct-paid invoice ($100 total, $40 paid) shows $60 still owing (got $${partial.outstanding_amount})`);

  const singleCheck = await getInvoiceOutstanding(db, directPaid.lastInsertRowid);
  assert(singleCheck === 0, `getInvoiceOutstanding() single-invoice check agrees: $0 outstanding (got $${singleCheck})`);

  // Confirm a NEW account payment correctly skips the already-directly-paid invoice
  // and lands on the genuinely outstanding ones instead — the "allocate to the
  // correct one" behavior this bug was breaking.
  const pay = await db.prepare(`INSERT INTO account_payments (carpark_id, account_customer_id, payment_date, amount, payment_method) VALUES (?, ?, '2026-07-01', 60, 'Internet Bank')`)
    .run(carparkId, accountId);
  const result = await allocateAccountPayment(db, { carparkId, accountCustomerId: accountId, paymentId: pay.lastInsertRowid, amount: 60 });
  assert(result.splits.length === 1 && result.splits[0].invoice_id === onAccUnpaid.lastInsertRowid,
    `new $60 payment correctly skips the already-paid Adelice invoice and lands on the genuinely outstanding OnAcc one`);

  console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');

  // Cleanup
  await db.prepare('DELETE FROM payment_allocations WHERE carpark_id = ? AND invoice_id IN (?, ?, ?)').run(carparkId, ...createdInvoiceIds);
  await db.prepare('DELETE FROM account_payments WHERE id = ?').run(pay.lastInsertRowid);
  await db.prepare('DELETE FROM invoices WHERE id IN (?, ?, ?)').run(...createdInvoiceIds);
  await db.prepare('DELETE FROM account_customers WHERE id = ?').run(accountId);

  process.exit(fail ? 1 : 0);
})();
