#!/usr/bin/env node
/**
 * Validates on-account tracking and drafting:
 * 1) Invoices are due on the 20th of the month after they are issued.
 * 2) An unsent invoice gets its own draft; once emailed it stops showing as unsent.
 * 3) A statement is drafted on the last day of the month, and only once every invoice it lists has been emailed.
 * 4) Friendly reminder before the 20th; only the latest overdue stage is drafted; one open reminder per account.
 * 5) Paying clears drafts; a statement already sent by any route is not drafted again.
 * 6) The emails say the right thing (invoice number, due date, days overdue, totals, escaped note).
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();
  const A = require('../src/utils/accountReminders');
  const { allocateAccountPayment } = require('../src/utils/paymentAllocation');

  let fail = false;
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail = true; } else { console.log('PASS:', msg); } };
  const cp = 1;
  const TODAY = '2026-10-23';

  // ── pure date rules ──────────────────────────────────────────────────────
  assert(A.invoiceDueYmd('2026-08-14') === '2026-09-20', 'issued 14 Aug -> due 20 Sep');
  assert(A.invoiceDueYmd('2026-12-31') === '2027-01-20', 'issued 31 Dec -> due 20 Jan next year');
  assert(A.statementMonthFor('2026-10-31') === '2026-10', 'last day of the month: this month\'s statement');
  assert(A.statementMonthFor('2026-11-05') === '2026-10', 'early next month: still last month\'s statement');
  assert(A.statementMonthFor('2026-11-25') === null, 'after the 20th: no statement is due');
  assert(A.statementMonthFor('2027-01-10') === '2026-12', 'January: December\'s statement');

  const created = { accounts: [], invoices: [] };
  const addAcct = async (name, email) => {
    const r = await db.prepare(`INSERT INTO account_customers (company_name, contact_name, email, billing_email, carpark_id, active, account_number) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run(name, 'Dana Test', email, email, cp, `ZZ-${Math.floor(Math.random() * 1e6)}`);
    created.accounts.push(r.lastInsertRowid);
    return r.lastInsertRowid;
  };
  let invNo = 990000 + Math.floor(Math.random() * 5000);
  const addInv = async (acct, dateIn, total, { emailed = true } = {}) => {
    const r = await db.prepare(`INSERT INTO invoices (invoice_number, carpark_id, account_customer_id, rego, date_in, return_date, total_price, paid_status, void, account_emailed_at, account_emailed_by)
      VALUES (?, ?, ?, 'ZZT123', ?, ?, ?, 'On Account', 0, ?, ?)`)
      .run(++invNo, cp, acct, dateIn, dateIn, total, emailed ? '2026-10-02 00:00:00' : null, emailed ? 'test' : null);
    created.invoices.push(r.lastInsertRowid);
    return { id: r.lastInsertRowid, number: invNo };
  };
  const draftsFor = (acct, extra = '') => db.prepare(`SELECT * FROM account_reminders WHERE account_customer_id = ? AND status = 'drafted' ${extra} ORDER BY id`).all(acct);

  const origSettings = await db.prepare('SELECT * FROM account_reminder_settings WHERE carpark_id = ?').get(cp);
  try {
    await db.prepare('DELETE FROM account_reminder_settings WHERE carpark_id = ?').run(cp);

    const alpha = await addAcct('ZZ ALPHA ROOFING', 'alpha@example.test');   // overdue, all emailed
    const bravo = await addAcct('ZZ BRAVO BUILDERS', 'bravo@example.test');  // one invoice not yet emailed
    const charlie = await addAcct('ZZ CHARLIE HIRE', 'charlie@example.test'); // not yet due, emailed
    const delta = await addAcct('ZZ DELTA NOMAIL', '');                       // no billing email
    const a1 = await addInv(alpha, '2026-08-14', 460);
    const a2 = await addInv(alpha, '2026-09-09', 345);
    const a3 = await addInv(alpha, '2026-10-06', 230);
    const b1 = await addInv(bravo, '2026-10-15', 690, { emailed: false });
    const c1 = await addInv(charlie, '2026-10-03', 230);
    const d1 = await addInv(delta, '2026-10-12', 115, { emailed: false });

    // ── status ─────────────────────────────────────────────────────────────
    const rows = await A.loadAccountsWithStatus(db, { carparkId: cp, todayYmd: TODAY });
    const st = (id) => rows.find((r) => r.account.id === id);
    assert(st(alpha).status.bucket === 'overdue' && st(alpha).status.days === -33, `oldest unpaid is 33 days overdue (got ${st(alpha).status.days})`);
    assert(st(alpha).status.owing === 1035 && st(alpha).status.overdueAmt === 805, 'owing $1,035.00 of which $805.00 overdue');
    assert(st(bravo).status.unsentCount === 1 && st(bravo).status.unsentAmt === 690, 'an invoice that has not been emailed is counted as unsent');
    assert(st(charlie).status.bucket === 'upcoming' && st(charlie).status.days === 28, 'not yet due: in 28 days');

    // ── drafts today (23 Oct) ──────────────────────────────────────────────
    const g1 = await A.generateDrafts(db, { carparkId: cp, todayYmd: TODAY });
    const alphaDrafts = await draftsFor(alpha);
    assert(alphaDrafts.length === 1 && alphaDrafts[0].kind === 'overdue' && alphaDrafts[0].rule_key === 'late30' && alphaDrafts[0].cycle_key === '2026-09-20', 'overdue account: ONE draft, the latest stage (30 days)');
    const bravoDrafts = await draftsFor(bravo);
    assert(bravoDrafts.length === 1 && bravoDrafts[0].kind === 'invoice' && bravoDrafts[0].invoice_id === b1.id, 'unsent invoice gets its own draft');
    assert((await draftsFor(charlie)).length === 0, 'not yet due and already emailed: nothing to draft');
    assert(g1.created >= 3, `drafts created (${g1.created})`);
    const g2 = await A.generateDrafts(db, { carparkId: cp, todayYmd: TODAY });
    assert(g2.created === 0, 'running again creates nothing');

    // listing
    const list = await A.listDrafts(db, { carparkId: cp, todayYmd: TODAY });
    const lAlpha = list.find((d) => d.accountId === alpha);
    assert(lAlpha && lAlpha.amount === 805 && lAlpha.days === -33, 'review list: overdue draft shows $805.00 and 33 days');
    const lDelta = list.find((d) => d.accountId === delta);
    assert(lDelta && lDelta.kind === 'invoice' && /billing email/.test(lDelta.warning || ''), 'an account with no email is flagged');

    // emailing an invoice retires its draft
    await A.markInvoicesEmailed(db, [b1.id], { to: 'bravo@example.test', by: 'test' });
    await A.generateDrafts(db, { carparkId: cp, todayYmd: TODAY });
    assert((await draftsFor(bravo)).length === 0, 'once the invoice is emailed its draft goes away');
    assert((await A.loadAccountsWithStatus(db, { carparkId: cp, todayYmd: TODAY, accountId: bravo }))[0].status.unsentCount === 0, '...and it no longer counts as unsent');

    // ── statement: last day of the month, gated on unsent invoices ──────────
    await db.prepare('UPDATE invoices SET account_emailed_at = NULL WHERE id = ?').run(b1.id); // pretend it was not sent
    const END = '2026-10-31';
    const g3 = await A.generateDrafts(db, { carparkId: cp, todayYmd: END });
    const stmt = (acct) => draftsFor(acct, "AND kind = 'statement'");
    assert((await stmt(charlie)).length === 1 && (await stmt(charlie))[0].cycle_key === '2026-10', 'statement drafted on the last day for an account whose invoices are all emailed');
    assert((await stmt(bravo)).length === 0 && g3.held.some((h) => h.accountId === bravo), 'statement held back while an invoice is still unsent');
    await A.markInvoicesEmailed(db, [b1.id], { to: 'bravo@example.test', by: 'test' });
    await A.generateDrafts(db, { carparkId: cp, todayYmd: END });
    assert((await stmt(bravo)).length === 1, 'once that invoice is emailed the statement is released');

    // already sent by any route -> not drafted again
    await db.prepare(`INSERT INTO email_logs (carpark_id, account_customer_id, account_name, month, year, sent_at, status, recipient_email) VALUES (?, ?, 'ZZ', 10, 2026, CURRENT_TIMESTAMP, 'sent', 'x@example.test')`).run(cp, charlie);
    await db.prepare(`UPDATE account_reminders SET status = 'skipped' WHERE account_customer_id = ? AND kind = 'statement'`).run(charlie);
    await A.generateDrafts(db, { carparkId: cp, todayYmd: '2026-11-02' });
    assert((await stmt(charlie)).length === 0, 'a statement already sent (e.g. from the Email page) is not drafted again');

    // ── friendly reminder before the 20th ──────────────────────────────────
    await db.prepare('DELETE FROM email_logs WHERE account_customer_id = ?').run(charlie);
    await A.generateDrafts(db, { carparkId: cp, todayYmd: '2026-11-16' });
    assert((await draftsFor(charlie, "AND kind = 'early'")).length === 0, '4 days before the 20th: too early for a reminder');
    await A.generateDrafts(db, { carparkId: cp, todayYmd: '2026-11-17' });
    const early = await draftsFor(charlie, "AND kind = 'early'");
    assert(early.length === 1 && early[0].cycle_key === '2026-11-20', 'three days before the 20th: friendly reminder drafted');

    // overdue stages replace each other as time passes
    const echo = await addAcct('ZZ ECHO ELECTRICAL', 'echo@example.test');
    await addInv(echo, '2026-08-14', 460);
    await A.generateDrafts(db, { carparkId: cp, todayYmd: '2026-09-22' });
    assert((await draftsFor(echo)).length === 0, 'two days overdue: too early for a notice');
    await A.generateDrafts(db, { carparkId: cp, todayYmd: '2026-09-23' });
    assert((await draftsFor(echo)).length === 1 && (await draftsFor(echo))[0].rule_key === 'late3', '3 days overdue: first notice drafted');
    await A.generateDrafts(db, { carparkId: cp, todayYmd: '2026-09-30' });
    const openEcho = await draftsFor(echo, "AND kind IN ('early','overdue')");
    assert(openEcho.length === 1 && openEcho[0].rule_key === 'late10', 'only one open reminder per account: 10 days overdue replaces the 3-day draft');

    // ── paying clears drafts ───────────────────────────────────────────────
    const pay = await db.prepare(`INSERT INTO account_payments (carpark_id, account_customer_id, payment_date, amount, payment_method) VALUES (?, ?, '2026-11-18', 805, 'Internet Bank')`).run(cp, alpha);
    await allocateAccountPayment(db, { carparkId: cp, accountCustomerId: alpha, paymentId: pay.lastInsertRowid, amount: 805 });
    await A.generateDrafts(db, { carparkId: cp, todayYmd: '2026-11-18' });
    const afterPay = await draftsFor(alpha, "AND kind = 'overdue'");
    assert(afterPay.length === 0, 'once the overdue invoices are paid, the overdue notice is cleared');

    // ── the emails ─────────────────────────────────────────────────────────
    const carpark = { name: 'BOI Car Storage Yard', bank_name: 'BNZ', bank_account_number: '00-0000-0000000-00' };
    const accountRow = await db.prepare('SELECT * FROM account_customers WHERE id = ?').get(alpha);
    const invRow = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(a3.id);
    const ie = A.buildInvoiceEmail({ carpark, account: accountRow, invoice: invRow, note: 'Thanks <b>again</b>' });
    assert(ie.subject.includes(`Invoice ${a3.number}`) && /\$230\.00/.test(ie.subject) && /20 November 2026/.test(ie.subject), `invoice subject names the invoice, amount and due date (${ie.subject})`);
    assert(new RegExp(`Reference:</strong> ${a3.number} \\(your invoice number\\)`).test(ie.html), 'an invoice email uses the invoice number as the payment reference');
    assert(ie.attachNames[0] === `Invoice-${a3.number}.pdf` && ie.to === 'alpha@example.test', 'invoice email goes to the billing email with the PDF named after the invoice');
    assert(ie.html.includes('Hi Dana,') && !ie.html.includes('<b>again</b>') && ie.html.includes('&lt;b&gt;again'), 'greets the contact by first name and escapes the personal note');

    // Alpha unpaid again for the overdue wording
    const fresh = await A.loadAccountsWithStatus(db, { carparkId: cp, todayYmd: TODAY });
    // (the payment above was dated 18 Nov; rebuild the picture as it was on 23 Oct by using only the unpaid list from before payment)
    const oe = A.buildOverdueEmail({
      carpark, account: accountRow, todayYmd: TODAY, note: null,
      unpaid: [
        { number: a1.number, rego: 'ZZT123', dateIn: '2026-08-14', due: '2026-09-20', days: -33, outstanding: 460, emailed: true },
        { number: a2.number, rego: 'ZZT123', dateIn: '2026-09-09', due: '2026-10-20', days: -3, outstanding: 345, emailed: true },
        { number: a3.number, rego: 'ZZT123', dateIn: '2026-10-06', due: '2026-11-20', days: 28, outstanding: 230, emailed: true },
      ],
    });
    assert(/33 days/.test(oe.html) && /\$805\.00/.test(oe.html) && /not yet due/.test(oe.html) && /\$230\.00/.test(oe.html), 'overdue email: days overdue, total overdue, and what is not yet due');
    assert(oe.count === 2 && oe.daysOverdue === 33 && /2 invoices overdue/.test(oe.subject), `overdue subject (${oe.subject})`);
    assert(/BNZ/.test(oe.html) && /00-0000-0000000-00/.test(oe.html), 'bank details are included');
    const ee = A.buildEarlyEmail({ carpark, account: accountRow, dueYmd: '2026-11-20', note: null, unpaid: [{ number: a3.number, rego: 'ZZT123', dateIn: '2026-10-06', due: '2026-11-20', days: 3, outstanding: 230, emailed: true }] });
    assert(/20 November 2026/.test(ee.subject) && /\$230\.00/.test(ee.html), 'friendly reminder names the due date and amount');
    void fresh;

    // settings
    const s = await A.saveSettings(db, cp, { rules: { invoice: true, statement: false, early: true, late3: true, late10: false, late30: true }, mode: 'auto' });
    const got = await A.getSettings(db, cp);
    assert(got.mode === 'auto' && got.rules.statement === false && got.rules.late10 === false, 'rules and send mode are saved');
    void s;
  } finally {
    const ids = created.accounts;
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      await db.prepare(`DELETE FROM payment_allocations WHERE payment_source = 'account' AND payment_id IN (SELECT id FROM account_payments WHERE account_customer_id IN (${ph}))`).run(...ids);
      await db.prepare(`DELETE FROM account_payments WHERE account_customer_id IN (${ph})`).run(...ids);
      await db.prepare(`DELETE FROM account_reminders WHERE account_customer_id IN (${ph})`).run(...ids);
      await db.prepare(`DELETE FROM email_logs WHERE account_customer_id IN (${ph})`).run(...ids);
      await db.prepare(`DELETE FROM invoices WHERE account_customer_id IN (${ph})`).run(...ids);
      await db.prepare(`DELETE FROM account_customers WHERE id IN (${ph})`).run(...ids);
    }
    await db.prepare('DELETE FROM account_reminder_settings WHERE carpark_id = ?').run(cp);
    if (origSettings) await db.prepare('INSERT INTO account_reminder_settings (carpark_id, rules, mode) VALUES (?, ?, ?)').run(origSettings.carpark_id, origSettings.rules, origSettings.mode);
  }

  console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
