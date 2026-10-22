const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { businessDateYmd, addCalendarDaysYmd } = require('../utils/businessDate');
const { logActivity, actorFromReq } = require('../utils/audit');
const { getTransporter, emailFrom, smtpErrorMessage, SMTP_MISSING_MSG } = require('../utils/mailer');
const R = require('../utils/ltReminders');
const router = express.Router();

async function loadOne(carparkId, id, todayYmd) {
  const d = await db.prepare('SELECT * FROM lt_reminders WHERE id = ? AND carpark_id = ?').get(id, carparkId);
  if (!d) return null;
  const customer = await db.prepare('SELECT * FROM longterm_customers WHERE id = ? AND carpark_id = ?').get(d.longterm_customer_id, carparkId);
  if (!customer) return null;
  const payments = await db.prepare('SELECT id, payment_date, amount_ex_gst, payment_batch_id FROM longterm_payments WHERE carpark_id = ? AND longterm_customer_id = ?').all(carparkId, customer.id);
  const status = R.computeStatus(customer, payments, todayYmd);
  const carpark = await db.prepare('SELECT * FROM carparks WHERE id = ?').get(carparkId);
  return { d, customer, status, carpark };
}

function buildFor(ctx, { months, note }, todayYmd) {
  return R.buildReminderEmail({
    carpark: ctx.carpark, customer: ctx.customer, status: ctx.status,
    kind: ctx.d.kind, months: months || ctx.d.months, note: (note || '').trim() || null, todayYmd,
  });
}

// GET /api/lt-reminders — drafts for today (created on the fly if due) + settings
router.get('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const today = businessDateYmd();
    await R.generateDrafts(db, { carparkId, todayYmd: today });
    const drafts = await R.listDrafts(db, { carparkId, todayYmd: today });
    const settings = await R.getSettings(db, carparkId);
    res.json({ today, drafts, settings, rules: R.RULES });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/settings', requireAuth, async (req, res) => {
  try {
    res.json({ ...(await R.getSettings(db, req.session.carparkId || 1)), rules: undefined, ruleList: R.RULES });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/settings', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const before = await R.getSettings(db, carparkId);
    const saved = await R.saveSettings(db, carparkId, req.body || {});
    const { userId, userName } = actorFromReq(req);
    await logActivity(db, { carparkId, tableName: 'lt_reminder_settings', recordId: carparkId, action: 'update', before, after: saved, userId, userName });
    res.json(saved);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/lt-reminders/customer/:ltId — a customer's reminder history
router.get('/customer/:ltId', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const rows = await db.prepare(`
      SELECT id, rule_key, cycle_due_date, kind, status, months, note, created_at, sent_at, sent_by
      FROM lt_reminders WHERE carpark_id = ? AND longterm_customer_id = ? ORDER BY id DESC LIMIT 20
    `).all(carparkId, parseInt(req.params.ltId, 10));
    res.json(rows.map((r) => ({ ...r, ruleLabel: (R.RULES.find((x) => x.key === r.rule_key) || {}).label || (r.rule_key === 'expired' ? 'Renewal offer' : (r.rule_key === 'manual' ? 'Payment request' : r.rule_key)) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/lt-reminders/manual { customerId } — staff want to send a payment
// request to one customer now. Opens their current draft if there is one,
// otherwise makes one for the review screen. Nothing is sent from here.
router.post('/manual', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const today = businessDateYmd();
    const customer = await db.prepare('SELECT * FROM longterm_customers WHERE id = ? AND carpark_id = ?').get(parseInt(req.body?.customerId, 10), carparkId);
    if (!customer) return res.status(404).json({ error: 'Long-term customer not found' });
    const payments = await db.prepare('SELECT id, payment_date, amount_ex_gst, payment_batch_id FROM longterm_payments WHERE carpark_id = ? AND longterm_customer_id = ?').all(carparkId, customer.id);
    const status = R.computeStatus(customer, payments, today);
    if (!status.nextDue) {
      return res.status(400).json({ error: 'Add a contract start date or record a payment first, so the due date can be worked out.' });
    }
    const open = await db.prepare(`SELECT id FROM lt_reminders WHERE longterm_customer_id = ? AND status = 'drafted' AND cycle_due_date = ? ORDER BY id DESC LIMIT 1`).get(customer.id, status.nextDue);
    if (open) {
      await db.prepare('UPDATE lt_reminders SET snoozed_until = NULL WHERE id = ?').run(open.id);
      return res.json({ id: open.id, existing: true });
    }
    const kind = status.expired ? 'expired' : status.days < 0 ? 'overdue' : status.days === 0 ? 'due' : 'reminder';
    await db.prepare(`
      INSERT INTO lt_reminders (carpark_id, longterm_customer_id, rule_key, cycle_due_date, kind, status, months)
      VALUES (?, ?, 'manual', ?, ?, 'drafted', ?)
      ON CONFLICT(longterm_customer_id, cycle_due_date, rule_key) DO UPDATE SET
        status = 'drafted', snoozed_until = NULL, kind = excluded.kind, months = excluded.months, sent_at = NULL
    `).run(carparkId, customer.id, status.nextDue, kind, status.nextMonths);
    const row = await db.prepare(`SELECT id FROM lt_reminders WHERE longterm_customer_id = ? AND cycle_due_date = ? AND rule_key = 'manual'`).get(customer.id, status.nextDue);
    res.json({ id: row.id, existing: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/lt-reminders/:id/preview?months=&note=
router.get('/:id/preview', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const today = businessDateYmd();
    const ctx = await loadOne(carparkId, req.params.id, today);
    if (!ctx) return res.status(404).json({ error: 'Reminder not found' });
    const months = parseInt(req.query.months, 10) || undefined;
    const email = buildFor(ctx, { months, note: req.query.note }, today);
    res.json({
      subject: email.subject, html: email.html, to: email.to || null,
      months: email.months, amounts: email.amounts, coversFrom: email.coversFrom, coversTo: email.coversTo,
      days: ctx.status.days, lastTerm: ctx.status.lastTerm,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function sendOne(req, id, { months, note }) {
  const carparkId = req.session.carparkId || 1;
  const today = businessDateYmd();
  const ctx = await loadOne(carparkId, id, today);
  if (!ctx) return { id, ok: false, error: 'Reminder not found' };
  if (ctx.d.status === 'sent') return { id, ok: false, error: 'Already sent' };
  const email = buildFor(ctx, { months, note }, today);
  if (!email.to) return { id, ok: false, error: `No email address on file for ${ctx.customer.name}` };
  const transporter = getTransporter();
  if (!transporter) return { id, ok: false, error: SMTP_MISSING_MSG };
  try {
    await transporter.sendMail({ from: emailFrom(), to: email.to, subject: email.subject, html: email.html });
  } catch (err) {
    return { id, ok: false, error: smtpErrorMessage(err) };
  }
  const { userId, userName } = actorFromReq(req);
  await db.prepare(`UPDATE lt_reminders SET status = 'sent', sent_at = CURRENT_TIMESTAMP, sent_by = ?, months = ?, note = ? WHERE id = ?`)
    .run(userName || 'staff', email.months, (note || '').trim() || null, id);
  await logActivity(db, {
    carparkId, tableName: 'lt_reminders', recordId: Number(id), action: 'send',
    before: null, after: { lt: ctx.customer.lt_number, to: email.to, kind: ctx.d.kind, rule: ctx.d.rule_key, months: email.months, amountInc: email.amounts.inc },
    notes: `Sent ${ctx.d.kind} reminder to ${ctx.customer.name} (${ctx.customer.lt_number})`, userId, userName,
  });
  return { id, ok: true, to: email.to, lt: ctx.customer.lt_number, name: ctx.customer.name };
}

router.post('/:id/send', requireAuth, async (req, res) => {
  try {
    const r = await sendOne(req, req.params.id, { months: parseInt(req.body?.months, 10) || undefined, note: req.body?.note });
    res.status(r.ok ? 200 : 400).json(r.ok ? { success: true, ...r } : { error: r.error });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/lt-reminders/send-batch { items: [{ id, months?, note? }] }
router.post('/send-batch', requireAuth, async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const results = [];
    for (const it of items) results.push(await sendOne(req, it.id, { months: parseInt(it.months, 10) || undefined, note: it.note }));
    res.json({ results, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/skip', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const d = await db.prepare('SELECT id, status FROM lt_reminders WHERE id = ? AND carpark_id = ?').get(req.params.id, carparkId);
    if (!d) return res.status(404).json({ error: 'Reminder not found' });
    await db.prepare(`UPDATE lt_reminders SET status = 'skipped', note = COALESCE(note, 'Skipped by staff') WHERE id = ? AND status = 'drafted'`).run(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/snooze', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const days = Math.max(1, Math.min(30, parseInt(req.body?.days, 10) || 3));
    const until = addCalendarDaysYmd(businessDateYmd(), days);
    const r = await db.prepare(`UPDATE lt_reminders SET snoozed_until = ? WHERE id = ? AND carpark_id = ? AND status = 'drafted'`).run(until, req.params.id, carparkId);
    if (!r.changes) return res.status(404).json({ error: 'Reminder not found' });
    res.json({ success: true, until });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
