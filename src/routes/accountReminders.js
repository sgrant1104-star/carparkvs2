const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { businessDateYmd, addCalendarDaysYmd } = require('../utils/businessDate');
const { logActivity, actorFromReq } = require('../utils/audit');
const { getTransporter, emailFrom, smtpErrorMessage, SMTP_MISSING_MSG } = require('../utils/mailer');
const { buildInvoicePdfBuffer } = require('../utils/invoicePdf');
const A = require('../utils/accountReminders');
const emailRoutes = require('./email');
const router = express.Router();

const KIND_LABEL = { invoice: 'Invoice', statement: 'Statement', early: 'Friendly reminder', overdue: 'Overdue notice' };
const noteHtml = (n) => `<p style="background:#fff8e6;border-radius:6px;padding:10px 12px;margin-top:16px;">${String(n).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`;

async function loadCtx(carparkId, id, todayYmd) {
  const draft = await db.prepare('SELECT * FROM account_reminders WHERE id = ? AND carpark_id = ?').get(id, carparkId);
  if (!draft) return null;
  const [row] = await A.loadAccountsWithStatus(db, { carparkId, todayYmd, accountId: draft.account_customer_id });
  if (!row) return null;
  const carpark = await db.prepare('SELECT * FROM carparks WHERE id = ?').get(carparkId);
  return { draft, account: row.account, unpaid: row.unpaid, carpark };
}

/** The email this draft would send right now (used by both preview and send). */
async function buildFor(ctx, { note }, todayYmd) {
  const { draft, account, unpaid, carpark } = ctx;
  const n = (note || '').trim() || null;
  if (draft.kind === 'invoice') {
    const invoice = await db.prepare(`
      SELECT i.*, ac.company_name AS account_name, ac.billing_address AS account_billing_address
      FROM invoices i LEFT JOIN account_customers ac ON ac.id = i.account_customer_id
      WHERE i.id = ? AND i.account_customer_id = ?
    `).get(draft.invoice_id, account.id);
    if (!invoice) throw new Error('Invoice not found');
    return { ...A.buildInvoiceEmail({ carpark, account, invoice, note: n }), invoice };
  }
  if (draft.kind === 'statement') {
    const month = parseInt(draft.cycle_key.slice(5, 7), 10);
    const year = parseInt(draft.cycle_key.slice(0, 4), 10);
    const p = await emailRoutes.prepareStatement({ carparkId: carpark.id, account, month, year });
    const html = n ? p.html.replace('<hr style="margin-top:30px;">', noteHtml(n) + '<hr style="margin-top:30px;">') : p.html;
    return { subject: p.subject, html, to: p.to, attachNames: p.attachNames, total: p.statementData.totalOutstanding, month, year };
  }
  if (draft.kind === 'overdue') return A.buildOverdueEmail({ carpark, account, unpaid, note: n, todayYmd });
  return A.buildEarlyEmail({ carpark, account, unpaid, dueYmd: draft.cycle_key, note: n });
}

/** Sends one draft. Shared by the screen buttons and the automatic morning job. */
async function sendDraft({ carparkId, id, note, userId = null, userName = 'staff', todayYmd }) {
  const ctx = await loadCtx(carparkId, id, todayYmd);
  if (!ctx) return { id, ok: false, error: 'Draft not found' };
  const { draft, account, carpark } = ctx;
  if (draft.status === 'sent') return { id, ok: false, error: 'Already sent' };
  if (!A.billingEmail(account)) return { id, ok: false, error: `No billing email on file for ${account.company_name}` };
  const transporter = getTransporter();
  if (!transporter) return { id, ok: false, error: SMTP_MISSING_MSG };

  try {
    let to = A.billingEmail(account);
    if (draft.kind === 'statement') {
      if (draft.rule_key !== 'manual') {
        const cutoff = A.endOfMonth(draft.cycle_key);
        const blockers = ctx.unpaid.filter((i) => i.dateIn <= cutoff && !i.emailed);
        if (blockers.length) return { id, ok: false, error: `${blockers.length} invoice${blockers.length === 1 ? '' : 's'} for ${account.company_name} ${blockers.length === 1 ? 'has' : 'have'} not been emailed yet — send those first` };
      }
      const month = parseInt(draft.cycle_key.slice(5, 7), 10);
      const year = parseInt(draft.cycle_key.slice(0, 4), 10);
      const r = await emailRoutes.sendStatement({ carparkId, account, month, year, transporter, by: userName, note: (note || '').trim() || null });
      to = r.to;
    } else {
      const email = await buildFor(ctx, { note }, todayYmd);
      to = email.to;
      if (!to) return { id, ok: false, error: `No billing email on file for ${account.company_name}` };
      const attachments = [];
      if (draft.kind === 'invoice') {
        try {
          attachments.push({ filename: email.attachNames[0], content: await buildInvoicePdfBuffer(email.invoice, carpark || {}) });
        } catch (e) { return { id, ok: false, error: `Could not build the PDF for invoice ${email.invoice.invoice_number}: ${e.message}` }; }
      }
      await transporter.sendMail({ from: emailFrom(), to, subject: email.subject, html: email.html, attachments });
      if (draft.kind === 'invoice') await A.markInvoicesEmailed(db, [draft.invoice_id], { to, by: userName });
    }
    await db.prepare(`UPDATE account_reminders SET status = 'sent', sent_at = CURRENT_TIMESTAMP, sent_by = ?, note = ? WHERE id = ?`)
      .run(userName, (note || '').trim() || null, id);
    await logActivity(db, {
      carparkId, tableName: 'account_reminders', recordId: Number(id), action: 'send',
      before: null, after: { account: account.company_name, to, kind: draft.kind, rule: draft.rule_key, cycle: draft.cycle_key, invoiceId: draft.invoice_id || null },
      notes: `Sent ${KIND_LABEL[draft.kind] || draft.kind} email to ${account.company_name}`, userId, userName,
    });
    return { id, ok: true, to, name: account.company_name, kind: draft.kind };
  } catch (err) {
    return { id, ok: false, error: smtpErrorMessage(err) };
  }
}

// GET /api/account-reminders — drafts for today (created on the fly if due) + settings
router.get('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const today = businessDateYmd();
    const gen = await A.generateDrafts(db, { carparkId, todayYmd: today });
    const drafts = await A.listDrafts(db, { carparkId, todayYmd: today });
    const settings = await A.getSettings(db, carparkId);
    res.json({ today, drafts, held: gen.held, settings, rules: A.RULES });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/settings', requireAuth, async (req, res) => {
  try { res.json({ ...(await A.getSettings(db, req.session.carparkId || 1)), ruleList: A.RULES }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/settings', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const before = await A.getSettings(db, carparkId);
    const saved = await A.saveSettings(db, carparkId, req.body || {});
    const { userId, userName } = actorFromReq(req);
    await logActivity(db, { carparkId, tableName: 'account_reminder_settings', recordId: carparkId, action: 'update', before, after: saved, userId, userName });
    res.json(saved);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/account-reminders/customer/:accountId — an account's email history
router.get('/customer/:accountId', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const rows = await db.prepare(`
      SELECT r.id, r.kind, r.rule_key, r.cycle_key, r.invoice_id, r.status, r.created_at, r.sent_at, r.sent_by, i.invoice_number
      FROM account_reminders r LEFT JOIN invoices i ON i.id = r.invoice_id
      WHERE r.carpark_id = ? AND r.account_customer_id = ? AND r.status != 'skipped'
      ORDER BY r.id DESC LIMIT 20
    `).all(carparkId, parseInt(req.params.accountId, 10));
    res.json(rows.map((r) => {
      let label = KIND_LABEL[r.kind] || r.kind;
      if (r.kind === 'invoice') label = `Invoice ${r.invoice_number || ''} emailed`.replace('  ', ' ');
      else if (r.kind === 'statement') label = `Statement — ${A.monthLabel(r.cycle_key)}`;
      else if (r.kind === 'overdue') label = `Overdue notice${(A.RULES.find((x) => x.key === r.rule_key) || {}).label ? ` · ${(A.RULES.find((x) => x.key === r.rule_key)).label}` : ''}`;
      return { ...r, label };
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/account-reminders/manual { accountId, kind, invoiceId?, month?, year?, force? }
// Staff want to send something to one account now. Opens (or creates) the draft
// for the review screen — nothing is sent from here.
router.post('/manual', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const today = businessDateYmd();
    const b = req.body || {};
    const accountId = parseInt(b.accountId, 10);
    const [row] = await A.loadAccountsWithStatus(db, { carparkId, todayYmd: today, accountId });
    if (!row) return res.status(404).json({ error: 'Account not found' });
    const { unpaid } = row;
    let kind = b.kind;
    let cycle; let invoiceId = 0;

    if (kind === 'invoice') {
      invoiceId = parseInt(b.invoiceId, 10);
      const inv = unpaid.find((i) => i.id === invoiceId);
      if (!inv) return res.status(400).json({ error: 'That invoice is paid or not found, so there is nothing to send.' });
      cycle = today;
    } else if (kind === 'statement') {
      const month = parseInt(b.month, 10); const year = parseInt(b.year, 10);
      if (!month || !year) return res.status(400).json({ error: 'month and year are required' });
      cycle = `${year}-${String(month).padStart(2, '0')}`;
      const listed = unpaid.filter((i) => i.dateIn <= A.endOfMonth(cycle));
      if (!listed.length) return res.status(400).json({ error: `Nothing is unpaid on this account for ${A.monthLabel(cycle)}, so there is no statement to send.` });
      const blockers = listed.filter((i) => !i.emailed);
      if (blockers.length && !b.force) {
        return res.status(409).json({ error: `${blockers.length} unpaid invoice${blockers.length === 1 ? ' has' : 's have'} not been emailed yet (${blockers.map((i) => i.number).join(', ')}). Send ${blockers.length === 1 ? 'it' : 'them'} first so the statement doesn't list something the customer hasn't seen.`, unsent: blockers.map((i) => i.number) });
      }
    } else if (kind === 'overdue') {
      const late = unpaid.filter((i) => i.days < 0 && i.emailed);
      if (!late.length) return res.status(400).json({ error: 'Nothing emailed is overdue on this account.' });
      cycle = late[0].due;
    } else {
      return res.status(400).json({ error: 'Unknown kind' });
    }

    const open = await db.prepare(`SELECT id FROM account_reminders WHERE account_customer_id = ? AND kind = ? AND cycle_key = ? AND invoice_id = ? AND status = 'drafted' ORDER BY id DESC LIMIT 1`)
      .get(accountId, kind, cycle, invoiceId);
    if (open) {
      await db.prepare('UPDATE account_reminders SET snoozed_until = NULL WHERE id = ?').run(open.id);
      return res.json({ id: open.id, existing: true });
    }
    await db.prepare(`
      INSERT INTO account_reminders (carpark_id, account_customer_id, kind, rule_key, cycle_key, invoice_id, status)
      VALUES (?, ?, ?, 'manual', ?, ?, 'drafted')
      ON CONFLICT(account_customer_id, kind, rule_key, cycle_key, invoice_id) DO UPDATE SET status = 'drafted', snoozed_until = NULL, sent_at = NULL
    `).run(carparkId, accountId, kind, cycle, invoiceId);
    const made = await db.prepare(`SELECT id FROM account_reminders WHERE account_customer_id = ? AND kind = ? AND rule_key = 'manual' AND cycle_key = ? AND invoice_id = ?`).get(accountId, kind, cycle, invoiceId);
    res.json({ id: made.id, existing: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/account-reminders/invoices/:invoiceId/mark-sent — it was already emailed some other way
router.post('/invoices/:invoiceId/mark-sent', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const id = parseInt(req.params.invoiceId, 10);
    const inv = await db.prepare('SELECT id, invoice_number, account_customer_id FROM invoices WHERE id = ? AND carpark_id = ? AND account_customer_id IS NOT NULL').get(id, carparkId);
    if (!inv) return res.status(404).json({ error: 'Account invoice not found' });
    const { userId, userName } = actorFromReq(req);
    await A.markInvoicesEmailed(db, [id], { to: 'marked as sent', by: userName || 'staff' });
    await db.prepare(`UPDATE account_reminders SET status = 'skipped', note = COALESCE(note, 'Marked as already sent') WHERE invoice_id = ? AND status = 'drafted'`).run(id);
    await logActivity(db, { carparkId, tableName: 'invoices', recordId: id, action: 'update', before: null, after: { accountEmailed: true }, notes: `Invoice ${inv.invoice_number} marked as already emailed to the account`, userId, userName });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/account-reminders/:id/preview?note=
router.get('/:id/preview', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const today = businessDateYmd();
    const ctx = await loadCtx(carparkId, req.params.id, today);
    if (!ctx) return res.status(404).json({ error: 'Draft not found' });
    const email = await buildFor(ctx, { note: req.query.note }, today);
    res.json({
      kind: ctx.draft.kind, subject: email.subject, html: email.html, to: email.to || null,
      attachNames: email.attachNames || [], total: email.total != null ? email.total : null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/send-batch', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { userId, userName } = actorFromReq(req);
    const today = businessDateYmd();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const results = [];
    for (const it of items) results.push(await sendDraft({ carparkId, id: it.id, note: it.note, userId, userName: userName || 'staff', todayYmd: today }));
    res.json({ results, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/send', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { userId, userName } = actorFromReq(req);
    const r = await sendDraft({ carparkId, id: req.params.id, note: req.body?.note, userId, userName: userName || 'staff', todayYmd: businessDateYmd() });
    res.status(r.ok ? 200 : 400).json(r.ok ? { success: true, ...r } : { error: r.error });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/skip', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const d = await db.prepare('SELECT id FROM account_reminders WHERE id = ? AND carpark_id = ?').get(req.params.id, carparkId);
    if (!d) return res.status(404).json({ error: 'Draft not found' });
    await db.prepare(`UPDATE account_reminders SET status = 'skipped', note = COALESCE(note, 'Skipped by staff') WHERE id = ? AND status = 'drafted'`).run(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/snooze', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const days = Math.max(1, Math.min(30, parseInt(req.body?.days, 10) || 3));
    const until = addCalendarDaysYmd(businessDateYmd(), days);
    const r = await db.prepare(`UPDATE account_reminders SET snoozed_until = ? WHERE id = ? AND carpark_id = ? AND status = 'drafted'`).run(until, req.params.id, carparkId);
    if (!r.changes) return res.status(404).json({ error: 'Draft not found' });
    res.json({ success: true, until });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * The 7am job: draft whatever is due. Only if the business has switched to
 * automatic does it also send — invoices first, then (once those are out)
 * statements and reminders. In "ask first" mode nothing is emailed.
 */
async function runDailyJob({ carparkId = 1, todayYmd }) {
  const gen = await A.generateDrafts(db, { carparkId, todayYmd });
  const settings = await A.getSettings(db, carparkId);
  const result = { created: gen.created, cleared: gen.cleared, held: gen.held.length, mode: settings.mode, autoSent: 0, autoFailed: 0 };
  if (settings.mode !== 'auto') return result;

  const sendOpen = async (kinds) => {
    const rows = await db.prepare(`SELECT id, kind, rule_key FROM account_reminders WHERE carpark_id = ? AND status = 'drafted' AND (snoozed_until IS NULL OR snoozed_until <= ?)`).all(carparkId, todayYmd);
    for (const d of rows.filter((r) => kinds.includes(r.kind))) {
      const r = await sendDraft({ carparkId, id: d.id, note: null, userName: 'Automatic', todayYmd });
      if (r.ok) result.autoSent++; else result.autoFailed++;
    }
  };
  await sendOpen(['invoice']);
  const again = await A.generateDrafts(db, { carparkId, todayYmd }); // statements are released once the invoices are out
  result.held = again.held.length;
  await sendOpen(['statement', 'early', 'overdue']);
  return result;
}

module.exports = router;
module.exports.runDailyJob = runDailyJob;
