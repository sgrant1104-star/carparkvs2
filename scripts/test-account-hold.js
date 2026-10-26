#!/usr/bin/env node
/**
 * Validates "put an account on hold":
 * 1) Only an account with something overdue can be put on hold.
 * 2) While held and overdue, blockFor() blocks (staff message names the amount; customer message does not).
 * 3) A hold on an account with nothing overdue does not block, and lifts itself.
 * 4) Paying what is overdue lifts the hold automatically; releasing by hand works too.
 * 5) Not-yet-due invoices don't count as overdue.
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();
  const H = require('../src/utils/accountHold');
  const { allocateAccountPayment } = require('../src/utils/paymentAllocation');

  let fail = false;
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail = true; } else { console.log('PASS:', msg); } };
  const cp = 1;
  const TODAY = '2026-10-23';
  const ids = [];
  let invNo = 980000 + Math.floor(Math.random() * 5000);

  try {
    const a = (await db.prepare(`INSERT INTO account_customers (company_name, contact_name, email, billing_email, carpark_id, active, account_number) VALUES ('ZZ HOLD TEST', 'Dana', 'h@example.test', 'h@example.test', ?, 1, ?)`)
      .run(cp, `ZH-${Math.floor(Math.random() * 1e6)}`)).lastInsertRowid;
    ids.push(a);
    const inv = async (dateIn, total) => (await db.prepare(`INSERT INTO invoices (invoice_number, carpark_id, account_customer_id, rego, date_in, return_date, total_price, paid_status, void) VALUES (?, ?, ?, 'ZZH1', ?, ?, ?, 'OnAcc', 0)`)
      .run(++invNo, cp, a, dateIn, dateIn, total)).lastInsertRowid;
    const load = () => db.prepare('SELECT * FROM account_customers WHERE id = ?').get(a);

    // only a not-yet-due invoice (issued 6 Oct, due 20 Nov)
    await inv('2026-10-06', 230);
    let threw = null;
    try { await H.setHold(db, { carparkId: cp, accountId: a, todayYmd: TODAY }); } catch (e) { threw = e; }
    assert(threw && threw.status === 400, 'cannot hold an account with nothing overdue');

    // an overdue invoice (issued 14 Aug, due 20 Sep)
    const overdueInv = await inv('2026-08-14', 460);
    const r = await H.setHold(db, { carparkId: cp, accountId: a, reason: 'No reply to 3 reminders', todayYmd: TODAY, userName: 'tester' });
    assert(r.overdueAmt === 460 && r.overdueCount === 1, `held: overdue $460.00 across 1 invoice (got ${r.overdueAmt}/${r.overdueCount})`);
    assert(!H.overdueOf([{ date_in: '2026-10-06', outstanding_amount: 230 }], TODAY).count, 'a not-yet-due invoice is not overdue');

    let blk = await H.blockFor(db, { carparkId: cp, accountId: a, todayYmd: TODAY });
    assert(blk && /ON HOLD/.test(blk.staffMessage) && /\$460\.00/.test(blk.staffMessage) && /No reply to 3 reminders/.test(blk.staffMessage), 'staff are told it is on hold, how much is overdue and why');
    assert(blk && !/460/.test(blk.customerMessage) && /on hold/.test(blk.customerMessage), 'the customer-facing message does not reveal the amount');

    // paying what is overdue lifts it
    const pay = await db.prepare(`INSERT INTO account_payments (carpark_id, account_customer_id, payment_date, amount, payment_method) VALUES (?, ?, '2026-10-24', 460, 'Internet Bank')`).run(cp, a);
    await allocateAccountPayment(db, { carparkId: cp, accountCustomerId: a, paymentId: pay.lastInsertRowid, amount: 460, targetInvoiceId: overdueInv });
    blk = await H.blockFor(db, { carparkId: cp, accountId: a, todayYmd: TODAY });
    assert(blk === null, 'once the overdue invoice is paid, the account is no longer blocked');
    assert(!(await load()).on_hold, '...and the hold lifted itself');

    // manual release
    await inv('2026-07-02', 90);
    await H.setHold(db, { carparkId: cp, accountId: a, todayYmd: TODAY, userName: 'tester' });
    assert(!!(await H.blockFor(db, { carparkId: cp, accountId: a, todayYmd: TODAY })), 'held again for a new overdue invoice');
    await H.releaseHold(db, { carparkId: cp, accountId: a, userName: 'tester' });
    assert((await H.blockFor(db, { carparkId: cp, accountId: a, todayYmd: TODAY })) === null && !(await load()).on_hold, 'staff can release a hold by hand');

    // an account that was never held is never blocked
    const b = (await db.prepare(`INSERT INTO account_customers (company_name, carpark_id, active, account_number) VALUES ('ZZ NOT HELD', ?, 1, ?)`).run(cp, `ZN-${Math.floor(Math.random() * 1e6)}`)).lastInsertRowid;
    ids.push(b);
    assert((await H.blockFor(db, { carparkId: cp, accountId: b, todayYmd: TODAY })) === null, 'an account that is not on hold is never blocked');
  } finally {
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      await db.prepare(`DELETE FROM payment_allocations WHERE payment_source = 'account' AND payment_id IN (SELECT id FROM account_payments WHERE account_customer_id IN (${ph}))`).run(...ids);
      await db.prepare(`DELETE FROM account_payments WHERE account_customer_id IN (${ph})`).run(...ids);
      await db.prepare(`DELETE FROM invoices WHERE account_customer_id IN (${ph})`).run(...ids);
      await db.prepare(`DELETE FROM account_customers WHERE id IN (${ph})`).run(...ids);
    }
  }

  console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
