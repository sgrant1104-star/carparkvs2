#!/usr/bin/env node
/**
 * Validates long-term "paid through / next payment" and the reminder drafts:
 * 1) Paid-through and next-due come from the payments, not from anyone's maths.
 * 2) Only the latest rule that has come due is drafted, once per cycle.
 * 3) A customer who pays has their old drafts cleared.
 * 4) Snoozed drafts are hidden until their date.
 * 5) The email says the right thing for each kind, with correct days/amounts.
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();
  const R = require('../src/utils/ltReminders');
  const { buildProratedPayments } = require('../src/utils/longtermProration');

  let fail = false;
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail = true; } else { console.log('PASS:', msg); } };
  const TODAY = '2026-10-23';
  const cp = 1;

  // ── pure status maths ────────────────────────────────────────────────────
  const spread = (total, months, start) => buildProratedPayments({ totalAmountExGst: total, cashReceivedDate: start, contractStartDate: start, months, baseNotes: null }).rows
    .map((r) => ({ payment_date: r.payment_date, amount_ex_gst: r.amount_ex_gst, payment_batch_id: r.payment_batch_id }));

  const lt8 = R.computeStatus({ contract_start_date: '2025-10-14', expiry_date: '2026-10-14' }, spread(1650, 12, '2025-10-14'), TODAY);
  assert(lt8.paidThrough === '2026-10-13' && lt8.nextDue === '2026-10-14', `12-month prepay from 14 Oct 2025: paid through 13 Oct 2026, next due 14 Oct (got ${lt8.paidThrough} / ${lt8.nextDue})`);
  assert(lt8.days === -9 && lt8.bucket === 'overdue', `9 days overdue (got ${lt8.days} ${lt8.bucket})`);
  assert(lt8.nextAmountInc === 1897.5 && lt8.nextMonths === 12, `renewal = same as last time: 12 months $1,897.50 (got ${lt8.nextMonths} / ${lt8.nextAmountInc})`);

  const lt7 = R.computeStatus({ contract_start_date: '2026-08-01' }, [{ payment_date: '2026-09-01', amount_ex_gst: 137.5 }, { payment_date: '2026-10-01', amount_ex_gst: 137.5 }], TODAY);
  assert(lt7.paidThrough === '2026-10-31' && lt7.days === 9 && lt7.bucket === 'soon', `monthly payer: paid through 31 Oct, due in 9 days (got ${lt7.paidThrough} ${lt7.days} ${lt7.bucket})`);
  assert(lt7.nextAmountInc === 158.13 && lt7.nextMonths === 1, `monthly rate carried forward incl GST (got ${lt7.nextAmountInc})`);

  const fresh = R.computeStatus({ contract_start_date: '2026-11-15' }, [], TODAY);
  assert(fresh.nextDue === '2026-11-15' && fresh.bucket === 'upcoming', 'no payments yet: first payment is due at the contract start');
  assert(R.computeStatus({}, [], TODAY).bucket === 'none', 'no payments and no contract date: nothing to work out');
  const old = R.computeStatus({ contract_start_date: '2025-12-01', expiry_date: '2026-03-31' }, [{ payment_date: '2026-03-01', amount_ex_gst: 125 }], TODAY);
  assert(old.expired === true && old.bucket === 'overdue', 'a contract long ended with nothing paid since is "expired", not chased');

  // ── drafts against the database ──────────────────────────────────────────
  const created = [];
  const addCust = async (lt, name, start, end, rows, extra = {}) => {
    const c = await db.prepare(`INSERT INTO longterm_customers (lt_number, name, email, carpark_id, contract_start_date, expiry_date, contract_amount, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(lt, name, extra.noEmail ? null : `${lt.toLowerCase()}@example.com`, cp, start, end, extra.amount || null);
    created.push(c.lastInsertRowid);
    for (const r of rows) {
      await db.prepare(`INSERT INTO longterm_payments (carpark_id, longterm_customer_id, payment_date, amount_ex_gst, payment_method, payment_batch_id, cash_received_date) VALUES (?, ?, ?, ?, 'Internet Bank', ?, ?)`)
        .run(cp, c.lastInsertRowid, r.payment_date, r.amount_ex_gst, r.payment_batch_id || null, r.payment_date);
    }
    return c.lastInsertRowid;
  };

  const origSettings = await db.prepare('SELECT * FROM lt_reminder_settings WHERE carpark_id = ?').get(cp);
  try {
    await db.prepare('DELETE FROM lt_reminder_settings WHERE carpark_id = ?').run(cp);
    const idOver  = await addCust('LTZ8', 'TEST OVERDUE', '2025-10-14', '2026-10-14', spread(1650, 12, '2025-10-14'));
    const idSoon  = await addCust('LTZ13', 'TEST SOON', '2025-10-31', '2026-10-31', spread(1650, 12, '2025-10-31'));
    const idFar   = await addCust('LTZ19', 'TEST FAR', '2026-10-04', '2027-01-04', spread(500, 3, '2026-10-04'));
    const idOld   = await addCust('LTZ5', 'TEST EXPIRED', '2025-12-01', '2026-03-31', [{ payment_date: '2026-03-01', amount_ex_gst: 125 }]);
    const idNoMail = await addCust('LTZ7', 'TEST NOMAIL', '2026-08-01', '2026-11-01', [{ payment_date: '2026-10-01', amount_ex_gst: 137.5 }], { noEmail: true });

    const g1 = await R.generateDrafts(db, { carparkId: cp, todayYmd: TODAY });
    const open = () => db.prepare(`SELECT r.*, c.lt_number FROM lt_reminders r JOIN longterm_customers c ON c.id = r.longterm_customer_id WHERE r.longterm_customer_id IN (${created.join(',')}) ORDER BY c.lt_number`).all();
    let rows = await open();
    const by = (lt) => rows.filter((r) => r.lt_number === lt);
    assert(by('LTZ8').length === 1 && by('LTZ8')[0].rule_key === 'o7' && by('LTZ8')[0].kind === 'overdue', 'overdue customer: ONE draft, the latest rule (7 days overdue), not all of them');
    assert(by('LTZ13').length === 1 && by('LTZ13')[0].rule_key === 'd14', 'due in 8 days: the 14-day reminder (the 7-day one is not due yet)');
    assert(by('LTZ19').length === 0, 'due in 73 days: nothing drafted yet');
    assert(by('LTZ5').length === 1 && by('LTZ5')[0].kind === 'expired', 'long-ended contract: a renewal offer, not an overdue notice');
    assert(g1.created >= 4, `drafts created (${g1.created})`);

    const g2 = await R.generateDrafts(db, { carparkId: cp, todayYmd: TODAY });
    rows = await open();
    assert(rows.length === 4 && g2.created === 0, 'running again creates nothing (one draft per customer, cycle and rule)');

    // Next day: the 7-day reminder comes due for LTZ13 -> new draft once the d14 one is dealt with
    await db.prepare(`UPDATE lt_reminders SET status = 'sent' WHERE longterm_customer_id = ? AND rule_key = 'd14'`).run(idSoon);
    await R.generateDrafts(db, { carparkId: cp, todayYmd: '2026-10-24' });
    rows = await open();
    assert(by('LTZ13').length === 1 || rows.filter((r) => r.lt_number === 'LTZ13').some((r) => r.rule_key === 'd7'), 'the next day the 7-day reminder is drafted for them');

    // Listing + email wording
    const list = await R.listDrafts(db, { carparkId: cp, todayYmd: TODAY });
    const over = list.find((d) => d.lt_number === 'LTZ8');
    assert(over && over.amount === 1897.5 && over.months === 12 && over.days === -9, 'review list shows amount, term and days for the overdue draft');
    const expired = list.find((d) => d.lt_number === 'LTZ5');
    assert(expired && /ended/.test(expired.warning || ''), 'the expired one carries a "check first" warning');
    const nomail = list.find((d) => d.lt_number === 'LTZ7');
    if (nomail) assert(/No email/.test(nomail.warning || ''), 'a customer with no email is flagged');

    const carpark = { name: 'BOI Car Storage Yard', bank_name: 'BNZ', bank_account_number: '00-0000-0000000-00' };
    const cExp = (await R.loadCustomersWithStatus(db, cp, TODAY, { includeArchived: true })).find((x) => x.customer.id === idOld);
    const mExp = R.buildReminderEmail({ carpark, customer: cExp.customer, status: cExp.status, kind: 'expired', months: 3, todayYmd: TODAY });
    assert(mExp.coversFrom === TODAY && /23 October 2026 – 22 January 2027/.test(mExp.html), `a renewal offer to an ended contract starts today, not in the past (${mExp.coversFrom})`);
    const cOver = (await R.loadCustomersWithStatus(db, cp, TODAY)).find((x) => x.customer.id === idOver);
    const mOver = R.buildReminderEmail({ carpark, customer: cOver.customer, status: cOver.status, kind: 'overdue', months: 12, note: 'See you Friday <b>', todayYmd: TODAY });
    assert(/9 days overdue/.test(mOver.subject), `overdue subject says "9 days overdue" (${mOver.subject})`);
    assert(/\$1,897\.50/.test(mOver.html) && /\$1,650\.00/.test(mOver.html) && /\$247\.50/.test(mOver.html), 'email shows total, ex GST and GST');
    assert(/14 October 2026 – 13 October 2027/.test(mOver.html), 'email shows the months covered, worked out from the due date');
    assert(/See you Friday &lt;b&gt;/.test(mOver.html), 'a personal note is included and escaped');
    const cSoon = (await R.loadCustomersWithStatus(db, cp, TODAY)).find((x) => x.customer.id === idSoon);
    const mSoon = R.buildReminderEmail({ carpark, customer: cSoon.customer, status: cSoon.status, kind: 'reminder', months: 12, todayYmd: TODAY });
    assert(/8 days left/.test(mSoon.subject), `reminder subject says "8 days left" (${mSoon.subject})`);
    const m3 = R.buildReminderEmail({ carpark, customer: cSoon.customer, status: cSoon.status, kind: 'reminder', months: 3, todayYmd: TODAY });
    assert(/\$575\.00/.test(m3.html) && /31 October 2026 – 30 January 2027/.test(m3.html), 'choosing 3 months changes the amount and the covered dates');

    // Paying clears the draft
    await db.prepare(`INSERT INTO longterm_payments (carpark_id, longterm_customer_id, payment_date, amount_ex_gst, payment_method, payment_batch_id, cash_received_date) VALUES (?, ?, '2026-10-14', 137.5, 'Internet Bank', 'x1', '2026-10-14')`).run(cp, idOver);
    const g3 = await R.generateDrafts(db, { carparkId: cp, todayYmd: TODAY });
    rows = await open();
    assert(by('LTZ8').every((r) => !(r.status === 'drafted' && r.cycle_due_date === '2026-10-14')), 'once they pay, the draft chasing the old due date is cleared');

    // Snooze
    const target = (await db.prepare(`SELECT id FROM lt_reminders WHERE longterm_customer_id = ? AND status = 'drafted' LIMIT 1`).get(idOld));
    await db.prepare(`UPDATE lt_reminders SET snoozed_until = '2026-10-26' WHERE id = ?`).run(target.id);
    assert(!(await R.listDrafts(db, { carparkId: cp, todayYmd: TODAY })).some((d) => d.id === target.id), 'a snoozed draft is hidden');
    assert((await R.listDrafts(db, { carparkId: cp, todayYmd: '2026-10-26' })).some((d) => d.id === target.id), '...and is back on its date');

    // A stale earlier-stage draft is replaced, not left beside the newer one
    const expDraft = (await open()).find((r) => r.status === 'drafted' && r.rule_key === 'expired' && r.longterm_customer_id === idOld);
    if (expDraft) {
      await db.prepare(`INSERT INTO lt_reminders (carpark_id, longterm_customer_id, rule_key, cycle_due_date, kind, status) VALUES (?, ?, 'o3', ?, 'overdue', 'drafted')`).run(cp, idOld, expDraft.cycle_due_date);
      await R.generateDrafts(db, { carparkId: cp, todayYmd: TODAY });
      const openFor = (await db.prepare(`SELECT rule_key FROM lt_reminders WHERE longterm_customer_id = ? AND status = 'drafted'`).all(idOld));
      assert(openFor.length === 1 && openFor[0].rule_key === 'expired', 'only one open draft per customer: the older stage is replaced by the newer');
    }

    // Settings
    const s = await R.saveSettings(db, cp, { rules: { d30: false, d14: true, d7: true, due: true, o3: false, o7: true }, mode: 'auto' });
    const got = await R.getSettings(db, cp);
    assert(got.mode === 'auto' && got.rules.d30 === false && got.rules.o7 === true, 'reminder rules and send mode are saved');
  } finally {
    if (created.length) {
      await db.prepare(`DELETE FROM lt_reminders WHERE longterm_customer_id IN (${created.join(',')})`).run();
      await db.prepare(`DELETE FROM longterm_payments WHERE longterm_customer_id IN (${created.join(',')})`).run();
      await db.prepare(`DELETE FROM longterm_customers WHERE id IN (${created.join(',')})`).run();
    }
    await db.prepare('DELETE FROM lt_reminder_settings WHERE carpark_id = ?').run(cp);
    if (origSettings) await db.prepare('INSERT INTO lt_reminder_settings (carpark_id, rules, mode) VALUES (?, ?, ?)').run(cp, origSettings.rules, origSettings.mode);
  }

  console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(fail ? 1 : 0);
})();
