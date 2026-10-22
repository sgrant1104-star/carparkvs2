/**
 * Long-term customers: when are they paid up to, when is the next payment
 * due, and which reminders should be drafted (for staff to review and send).
 *
 * "Paid through" is worked out from the payments themselves — the last month
 * any payment is counted in, plus one month — so nobody has to calculate it.
 * Reminders are only ever DRAFTED here; a person approves each one before it
 * is sent (unless the business switches the mode to automatic).
 */
const { addMonthsYmd, LT_TERM_TOTALS, isPlausibleDate } = require('./longtermProration');
const { addCalendarDaysYmd } = require('./businessDate');

const GST = 1.15;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ymd = (v) => String(v || '').slice(0, 10);

function diffDays(fromYmd, toYmd) {
  const a = new Date(`${fromYmd}T00:00:00Z`);
  const b = new Date(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

// offset = days from the due date (negative = before, positive = overdue)
const RULES = [
  { key: 'd30', offset: -30, label: '30 days before', kind: 'reminder' },
  { key: 'd14', offset: -14, label: '14 days before', kind: 'reminder' },
  { key: 'd7',  offset: -7,  label: '7 days before',  kind: 'reminder' },
  { key: 'due', offset: 0,   label: 'On the due date', kind: 'due' },
  { key: 'o3',  offset: 3,   label: '3 days overdue', kind: 'overdue' },
  { key: 'o7',  offset: 7,   label: '7 days overdue', kind: 'overdue' },
];
const DEFAULT_RULES = Object.fromEntries(RULES.map((r) => [r.key, true]));

/** A contract this far past its expiry with nothing paid is treated as "ended" — offer renewal, don't chase. */
const EXPIRED_AFTER_DAYS = 60;

/**
 * @param customer  longterm_customers row
 * @param payments  longterm_payments rows for that customer
 * @param todayYmd  business date
 */
function computeStatus(customer, payments, todayYmd) {
  const rows = (payments || [])
    .filter((p) => isPlausibleDate(ymd(p.payment_date)))
    .sort((a, b) => ymd(a.payment_date).localeCompare(ymd(b.payment_date)));
  const contractStart = ymd(customer.contract_start_date) || null;
  const contractEnd = ymd(customer.expiry_date) || null;

  let paidThrough = null;
  let nextDue = null;
  let lastTerm = null;

  if (rows.length) {
    // One group per payment: a batch (a prepay spread over N months) or a
    // single month. A group covers from its FIRST month for N months — not
    // "last month + 1", which drifts a day when a spread from the 31st
    // lands on shorter months (31 Oct, 30 Nov ... 30 Sep).
    const groups = new Map();
    for (const r of rows) {
      const key = r.payment_batch_id || `row-${ymd(r.payment_date)}-${r.id || ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    let best = null;
    for (const g of groups.values()) {
      const first = ymd(g[0].payment_date);
      const end = addCalendarDaysYmd(addMonthsYmd(first, g.length), -1);
      if (!best || end > best.end) best = { end, rows: g };
    }
    paidThrough = best.end;
    nextDue = addCalendarDaysYmd(paidThrough, 1);
    // "Same as last time": the length and amount of the payment that runs furthest.
    lastTerm = {
      months: best.rows.length,
      totalExGst: round2(best.rows.reduce((s, r) => s + (parseFloat(r.amount_ex_gst) || 0), 0)),
    };
  } else if (contractStart) {
    nextDue = contractStart;
  }

  const days = nextDue ? diffDays(todayYmd, nextDue) : null;
  let bucket = 'none';
  if (days != null) bucket = days < 0 ? 'overdue' : days <= 14 ? 'soon' : days <= 60 ? 'upcoming' : 'paid';

  const expired = !!(days != null && days < -EXPIRED_AFTER_DAYS && contractEnd && contractEnd < todayYmd);

  let nextAmountInc = null;
  if (lastTerm) nextAmountInc = round2(lastTerm.totalExGst * GST);
  else if (customer.contract_amount != null && customer.contract_amount !== '') nextAmountInc = round2(parseFloat(customer.contract_amount) * GST);

  return {
    paidThrough, nextDue, days, bucket, expired,
    contractStart, contractEnd,
    lastTerm, nextAmountInc,
    nextMonths: lastTerm ? lastTerm.months : null,
    paymentCount: rows.length,
  };
}

/** Price (ex GST) of a renewal of `months`: the customer's own last rate if it's the same length, else the standard term price. */
function priceExGst(lastTerm, months) {
  if (lastTerm && Number(lastTerm.months) === Number(months)) return lastTerm.totalExGst;
  return LT_TERM_TOTALS[months] != null ? LT_TERM_TOTALS[months] : round2((LT_TERM_TOTALS[1] || 200) * months);
}

function amounts(lastTerm, months) {
  const ex = priceExGst(lastTerm, months);
  const inc = round2(ex * GST);
  return { ex: round2(ex), gst: round2(inc - ex), inc };
}

// ── Settings ────────────────────────────────────────────────────────────────
async function getSettings(db, carparkId) {
  const row = await db.prepare('SELECT rules, mode FROM lt_reminder_settings WHERE carpark_id = ?').get(carparkId);
  let rules = { ...DEFAULT_RULES };
  if (row && row.rules) { try { rules = { ...rules, ...JSON.parse(row.rules) }; } catch (_) {} }
  return { rules, mode: row && row.mode === 'auto' ? 'auto' : 'ask' };
}

async function saveSettings(db, carparkId, { rules, mode }) {
  const clean = {};
  for (const r of RULES) clean[r.key] = !!(rules && rules[r.key]);
  const m = mode === 'auto' ? 'auto' : 'ask';
  await db.prepare(`
    INSERT INTO lt_reminder_settings (carpark_id, rules, mode) VALUES (?, ?, ?)
    ON CONFLICT(carpark_id) DO UPDATE SET rules = excluded.rules, mode = excluded.mode
  `).run(carparkId, JSON.stringify(clean), m);
  return { rules: clean, mode: m };
}

// ── Drafting ────────────────────────────────────────────────────────────────
async function loadCustomersWithStatus(db, carparkId, todayYmd, { includeArchived = false } = {}) {
  const customers = await db.prepare(`
    SELECT * FROM longterm_customers WHERE carpark_id = ? ${includeArchived ? '' : 'AND active = 1'}
    ORDER BY CAST(REPLACE(lt_number, 'LT', '') AS INTEGER)
  `).all(carparkId);
  const payments = await db.prepare(`
    SELECT id, longterm_customer_id, payment_date, amount_ex_gst, payment_batch_id FROM longterm_payments WHERE carpark_id = ?
  `).all(carparkId);
  const byCust = new Map();
  for (const p of payments) {
    if (!byCust.has(p.longterm_customer_id)) byCust.set(p.longterm_customer_id, []);
    byCust.get(p.longterm_customer_id).push(p);
  }
  return customers.map((c) => ({ customer: c, status: computeStatus(c, byCust.get(c.id) || [], todayYmd) }));
}

/**
 * Creates drafts for whatever is due today. Idempotent: at most one draft per
 * customer, payment cycle and rule. Only the latest rule that has come due is
 * drafted (a customer who is 5 days from the due date isn't also offered the
 * 30-day and 14-day reminders they never got), and drafts for a cycle that has
 * since been paid are cleared.
 */
async function generateDrafts(db, { carparkId = 1, todayYmd }) {
  const settings = await getSettings(db, carparkId);
  const all = await loadCustomersWithStatus(db, carparkId, todayYmd);
  let created = 0;
  let cleared = 0;

  for (const { customer, status } of all) {
    // Paid since: any still-open draft for an older cycle is no longer needed.
    const open = await db.prepare(`SELECT id, cycle_due_date FROM lt_reminders WHERE longterm_customer_id = ? AND status = 'drafted'`).all(customer.id);
    for (const o of open) {
      if (!status.nextDue || o.cycle_due_date !== status.nextDue) {
        await db.prepare(`UPDATE lt_reminders SET status = 'skipped', note = COALESCE(note, 'Payment recorded — no longer needed') WHERE id = ?`).run(o.id);
        cleared++;
      }
    }
    if (!status.nextDue) continue;

    let pick = null;
    if (status.expired) {
      pick = { key: 'expired', kind: 'expired' };
    } else {
      const due = RULES
        .filter((r) => settings.rules[r.key])
        .map((r) => ({ r, trigger: addCalendarDaysYmd(status.nextDue, r.offset) }))
        .filter((x) => x.trigger <= todayYmd)
        .sort((a, b) => a.trigger.localeCompare(b.trigger));
      if (due.length) pick = { key: due[due.length - 1].r.key, kind: due[due.length - 1].r.kind };
    }
    if (!pick) continue;

    // One open draft per customer: a newer stage (e.g. the overdue notice, or
    // the renewal offer) replaces an older unsent one for the same payment.
    // Drafts staff asked for by hand ('manual') are left alone.
    for (const o of open) {
      if (o.cycle_due_date !== status.nextDue) continue;
      const row = await db.prepare(`SELECT rule_key, status FROM lt_reminders WHERE id = ?`).get(o.id);
      if (row && row.status === 'drafted' && row.rule_key !== pick.key && row.rule_key !== 'manual') {
        await db.prepare(`UPDATE lt_reminders SET status = 'skipped', note = COALESCE(note, 'Replaced by a newer reminder') WHERE id = ?`).run(o.id);
        cleared++;
      }
    }

    const exists =await db.prepare(`SELECT id FROM lt_reminders WHERE longterm_customer_id = ? AND cycle_due_date = ? AND rule_key = ?`).get(customer.id, status.nextDue, pick.key);
    if (exists) continue;
    await db.prepare(`
      INSERT INTO lt_reminders (carpark_id, longterm_customer_id, rule_key, cycle_due_date, kind, status, months)
      VALUES (?, ?, ?, ?, ?, 'drafted', ?)
    `).run(carparkId, customer.id, pick.key, status.nextDue, pick.kind, status.nextMonths);
    created++;
  }
  return { created, cleared };
}

const KIND_LABEL = { reminder: 'Payment reminder', due: 'Payment due today', overdue: 'Overdue notice', expired: 'Renewal offer' };

/** Open drafts (snoozed ones hidden until their date), with everything the review screen needs. */
async function listDrafts(db, { carparkId = 1, todayYmd }) {
  const drafts = await db.prepare(`
    SELECT r.* FROM lt_reminders r
    WHERE r.carpark_id = ? AND r.status = 'drafted' AND (r.snoozed_until IS NULL OR r.snoozed_until <= ?)
    ORDER BY r.created_at ASC, r.id ASC
  `).all(carparkId, todayYmd);
  const all = await loadCustomersWithStatus(db, carparkId, todayYmd, { includeArchived: true });
  const byId = new Map(all.map((x) => [x.customer.id, x]));
  const out = [];
  for (const d of drafts) {
    const c = byId.get(d.longterm_customer_id);
    if (!c) continue;
    const months = d.months || c.status.nextMonths || 1;
    out.push({
      id: d.id, rule_key: d.rule_key, kind: d.kind, kindLabel: KIND_LABEL[d.kind] || 'Reminder',
      customerId: c.customer.id, lt_number: c.customer.lt_number, name: c.customer.name,
      hasEmail: !!String(c.customer.email || '').trim(),
      days: c.status.days, nextDue: c.status.nextDue, paidThrough: c.status.paidThrough,
      months, amount: amounts(c.status.lastTerm, months).inc,
      lastTerm: c.status.lastTerm,
      expired: c.status.expired,
      warning: d.kind === 'expired'
        ? `This contract ended on ${c.status.contractEnd || 'an earlier date'} and nothing has been paid since. Check they still want the space before sending — or archive them instead.`
        : (!String(c.customer.email || '').trim() ? 'No email address on file — add one before this can be sent.' : null),
    });
  }
  return out;
}

// ── The email ──────────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n) => `$${(Number(n) || 0).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDate = (y) => {
  if (!y) return '';
  const d = new Date(`${y}T00:00:00Z`);
  return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const firstName = (name) => {
  const w = String(name || '').trim().split(/\s+/)[0] || 'there';
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
};
const dayWord = (n) => `${n} day${n === 1 ? '' : 's'}`;

/**
 * @returns {{ subject, html, to, months, amounts, coversFrom, coversTo }}
 */
function buildReminderEmail({ carpark, customer, status, kind, months, note, todayYmd }) {
  const m = Number(months) || status.nextMonths || 1;
  const amt = amounts(status.lastTerm, m);
  // A renewal offer to an ended contract starts today — the period it would
  // otherwise "cover" (from the last payment) has already gone.
  const from = kind === 'expired' ? todayYmd : (status.nextDue || todayYmd);
  const to = addCalendarDaysYmd(addMonthsYmd(from, m), -1);
  const lt = customer.lt_number;
  const first = firstName(customer.name);
  const days = status.days == null ? 0 : status.days;
  const n = Math.abs(days);
  const dueText = longDate(status.nextDue);
  const payBy = kind === 'overdue' || kind === 'due' ? longDate(addCalendarDaysYmd(todayYmd, 7)) : dueText;
  const termWord = m === 1 ? 'monthly payment' : `${m}-month renewal`;
  const isMonthly = m === 1 && status.lastTerm && status.lastTerm.months === 1;

  let subject; let intro;
  if (kind === 'overdue') {
    subject = `${first}, your long-term parking payment (${lt}) is ${dayWord(n)} overdue`;
    intro = [`Your payment for long-term contract ${lt} was due on ${dueText} and is now ${dayWord(n)} overdue.`, `To keep your space, please pay by ${payBy}.`];
  } else if (kind === 'due') {
    subject = `${first}, your long-term parking payment (${lt}) is due today`;
    intro = [`Your payment for long-term contract ${lt} is due today, ${dueText}.`];
  } else if (kind === 'expired') {
    subject = `${first}, would you like to keep your space? (${lt})`;
    intro = [`Your long-term contract ${lt} ended on ${longDate(status.contractEnd) || dueText}. If you would like to continue, the renewal is below — or just let us know and we will close the contract.`];
  } else if (isMonthly) {
    subject = `${first}, your monthly parking payment (${lt}) is due ${dueText}`;
    intro = [`Your next monthly payment for ${lt} is due on ${dueText} (${dayWord(n)} from now).`];
  } else {
    subject = `${first}, ${dayWord(n)} left on your long-term parking (${lt})`;
    intro = [`Your long-term contract ${lt} is paid up to ${longDate(status.paidThrough)}, so you have ${dayWord(n)} left. Your next payment is due on ${dueText}.`, 'To keep your space without a gap, here is your renewal:'];
  }

  const bank = [
    carpark && carpark.bank_name ? `<p style="margin:2px 0"><strong>Bank:</strong> ${esc(carpark.bank_name)}</p>` : '',
    carpark && carpark.bank_account_name ? `<p style="margin:2px 0"><strong>Account name:</strong> ${esc(carpark.bank_account_name)}</p>` : '',
    carpark && carpark.bank_account_number ? `<p style="margin:2px 0"><strong>Account number:</strong> ${esc(carpark.bank_account_number)}</p>` : '',
    `<p style="margin:2px 0"><strong>Reference:</strong> ${esc(carpark && carpark.bank_reference ? `${carpark.bank_reference} — ${lt}` : lt)}</p>`,
  ].join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;padding:20px;color:#333;line-height:1.55;">
  <h2 style="color:#1a5276;margin:0 0 14px;">${esc(carpark && carpark.name ? carpark.name : 'Car Storage')}</h2>
  <p>Hi ${esc(first)},</p>
  ${intro.map((t) => `<p>${esc(t)}</p>`).join('\n  ')}
  <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f2f7fa;border-radius:8px;">
    <tr><td style="padding:12px;"><strong>${esc(termWord.charAt(0).toUpperCase() + termWord.slice(1))} (inc GST)</strong></td><td style="padding:12px;text-align:right;font-size:18px;"><strong>${money(amt.inc)}</strong></td></tr>
    <tr><td style="padding:8px 12px;border-top:1px solid #dee2e6;color:#666;">Amount ex GST</td><td style="padding:8px 12px;border-top:1px solid #dee2e6;text-align:right;color:#666;">${money(amt.ex)}</td></tr>
    <tr><td style="padding:8px 12px;border-top:1px solid #dee2e6;color:#666;">GST (15%)</td><td style="padding:8px 12px;border-top:1px solid #dee2e6;text-align:right;color:#666;">${money(amt.gst)}</td></tr>
    <tr><td style="padding:8px 12px;border-top:1px solid #dee2e6;color:#666;">Covers</td><td style="padding:8px 12px;border-top:1px solid #dee2e6;text-align:right;color:#666;">${esc(longDate(from))} – ${esc(longDate(to))}</td></tr>
  </table>
  <p>Please pay by internet banking:</p>
  ${bank}
  ${note ? `<p style="background:#fff8e6;border-radius:6px;padding:10px 12px;margin-top:16px;">${esc(note)}</p>` : ''}
  <p style="margin-top:20px;">Thanks,<br>${esc(carpark && carpark.name ? carpark.name : 'Car Storage')}</p>
  <p style="color:#7f8c8d;font-size:12px;margin-top:18px;">${esc(carpark && carpark.address ? carpark.address : '')}<br>${esc(carpark && carpark.phone ? carpark.phone : '')}</p>
</body></html>`;

  return { subject, html, to: String(customer.email || '').trim(), months: m, amounts: amt, coversFrom: from, coversTo: to };
}

/**
 * The daily job: draft what's due and, ONLY if the business has switched to
 * automatic mode, send it. Renewal offers to ended contracts are never sent
 * automatically (a person should check those first).
 */
async function runDailyJob(db, { carparkId = 1, todayYmd }) {
  const { getTransporter, emailFrom } = require('./mailer');
  const { logActivity } = require('./audit');
  const gen = await generateDrafts(db, { carparkId, todayYmd });
  const settings = await getSettings(db, carparkId);
  const result = { ...gen, mode: settings.mode, autoSent: 0, autoFailed: 0 };
  if (settings.mode !== 'auto') return result;

  const transporter = getTransporter();
  if (!transporter) return result;
  const carpark = await db.prepare('SELECT * FROM carparks WHERE id = ?').get(carparkId);
  const all = await loadCustomersWithStatus(db, carparkId, todayYmd, { includeArchived: true });
  const byId = new Map(all.map((x) => [x.customer.id, x]));
  const open = await db.prepare(`SELECT * FROM lt_reminders WHERE carpark_id = ? AND status = 'drafted' AND (snoozed_until IS NULL OR snoozed_until <= ?)`).all(carparkId, todayYmd);
  for (const d of open) {
    if (d.kind === 'expired') continue;
    const c = byId.get(d.longterm_customer_id);
    if (!c) continue;
    const email = buildReminderEmail({ carpark, customer: c.customer, status: c.status, kind: d.kind, months: d.months, note: null, todayYmd });
    if (!email.to) { result.autoFailed++; continue; }
    try {
      await transporter.sendMail({ from: emailFrom(), to: email.to, subject: email.subject, html: email.html });
      await db.prepare(`UPDATE lt_reminders SET status = 'sent', sent_at = CURRENT_TIMESTAMP, sent_by = 'auto', months = ? WHERE id = ?`).run(email.months, d.id);
      await logActivity(db, { carparkId, tableName: 'lt_reminders', recordId: d.id, action: 'send', after: { lt: c.customer.lt_number, to: email.to, kind: d.kind, auto: true }, notes: `Auto-sent ${d.kind} reminder to ${c.customer.name}`, userName: 'Automatic' });
      result.autoSent++;
    } catch (e) { result.autoFailed++; }
  }
  return result;
}

module.exports = {
  RULES, DEFAULT_RULES, KIND_LABEL, GST,
  runDailyJob,
  computeStatus, priceExGst, amounts,
  getSettings, saveSettings, loadCustomersWithStatus,
  generateDrafts, listDrafts, buildReminderEmail,
  diffDays, firstName,
};
