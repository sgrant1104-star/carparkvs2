/**
 * On-account customers: which invoices have been emailed, which are unpaid or
 * overdue, and which emails should be DRAFTED (for staff to review and send).
 *
 * Terms: an invoice is due on the 20th of the month after it was issued.
 * Staff email each invoice on its own, then the monthly statement. Nothing is
 * sent from here unless the business has switched the mode to automatic.
 */
const { getAccountInvoicesWithOutstanding } = require('./paymentAllocation');
const { addCalendarDaysYmd } = require('./businessDate');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ymd = (v) => String(v || '').slice(0, 10);

// offset = days from the due date (negative = before, positive = overdue)
const RULES = [
  { key: 'invoice',   label: 'Each invoice, once issued',                         group: 'invoice' },
  { key: 'statement', label: 'Monthly statement, last day of the month',          group: 'statement' },
  { key: 'early',     label: 'Friendly reminder, 3 days before the 20th', offset: -3, group: 'early' },
  { key: 'late3',     label: '3 days overdue',  offset: 3,  group: 'overdue' },
  { key: 'late10',    label: '10 days overdue', offset: 10, group: 'overdue' },
  { key: 'late30',    label: '30 days overdue', offset: 30, group: 'overdue' },
];
const DEFAULT_RULES = Object.fromEntries(RULES.map((r) => [r.key, true]));

function diffDays(fromYmd, toYmd) {
  return Math.round((new Date(`${toYmd}T00:00:00Z`) - new Date(`${fromYmd}T00:00:00Z`)) / 86400000);
}

/** Due on the 20th of the month after the invoice date. */
function invoiceDueYmd(dateIn) {
  const s = ymd(dateIn);
  const y = parseInt(s.slice(0, 4), 10);
  const m = parseInt(s.slice(5, 7), 10);
  if (!y || !m) return null;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-20`;
}

const isLastDayOfMonth = (t) => addCalendarDaysYmd(t, 1).slice(0, 7) !== t.slice(0, 7);
function prevMonthKey(t) {
  const y = parseInt(t.slice(0, 4), 10);
  const m = parseInt(t.slice(5, 7), 10);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
function endOfMonth(key) {
  const y = parseInt(key.slice(0, 4), 10);
  const m = parseInt(key.slice(5, 7), 10);
  return `${key}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (key) => `${MONTHS[parseInt(key.slice(5, 7), 10) - 1]} ${key.slice(0, 4)}`;

/** The month whose statement is currently due to be drafted (null = none right now). */
function statementMonthFor(todayYmd) {
  if (isLastDayOfMonth(todayYmd)) return todayYmd.slice(0, 7);
  if (parseInt(todayYmd.slice(8, 10), 10) <= 20) return prevMonthKey(todayYmd);
  return null;
}

const billingEmail = (a) => String((a && (a.billing_email || a.email)) || '').trim();

// ── Settings ────────────────────────────────────────────────────────────────
async function getSettings(db, carparkId) {
  const row = await db.prepare('SELECT rules, mode FROM account_reminder_settings WHERE carpark_id = ?').get(carparkId);
  let rules = { ...DEFAULT_RULES };
  if (row && row.rules) { try { rules = { ...rules, ...JSON.parse(row.rules) }; } catch (_) {} }
  return { rules, mode: row && row.mode === 'auto' ? 'auto' : 'ask' };
}

async function saveSettings(db, carparkId, { rules, mode }) {
  const clean = {};
  for (const r of RULES) clean[r.key] = !!(rules && rules[r.key]);
  const m = mode === 'auto' ? 'auto' : 'ask';
  await db.prepare(`
    INSERT INTO account_reminder_settings (carpark_id, rules, mode) VALUES (?, ?, ?)
    ON CONFLICT(carpark_id) DO UPDATE SET rules = excluded.rules, mode = excluded.mode
  `).run(carparkId, JSON.stringify(clean), m);
  return { rules: clean, mode: m };
}

// ── Status ──────────────────────────────────────────────────────────────────
/**
 * Every active account with its unpaid invoices (issued on or before today),
 * each marked emailed / not emailed, plus the headline numbers.
 */
async function loadAccountsWithStatus(db, { carparkId = 1, todayYmd, accountId = null }) {
  const accounts = await db.prepare(`
    SELECT * FROM account_customers WHERE carpark_id = ? AND active = 1 ${accountId ? 'AND id = ?' : ''} ORDER BY company_name
  `).all(...(accountId ? [carparkId, accountId] : [carparkId]));

  const pays = await db.prepare(`
    SELECT account_customer_id, payment_date, amount FROM account_payments WHERE carpark_id = ? ORDER BY payment_date DESC, id DESC
  `).all(carparkId);
  const lastPay = new Map();
  for (const p of pays) if (!lastPay.has(p.account_customer_id)) lastPay.set(p.account_customer_id, p);

  const out = [];
  for (const account of accounts) {
    const all = await getAccountInvoicesWithOutstanding(db, { carparkId, accountCustomerId: account.id });
    const unpaid = all
      .filter((i) => i.outstanding_amount > 0.01 && ymd(i.date_in) && ymd(i.date_in) <= todayYmd)
      .map((i) => {
        const due = invoiceDueYmd(i.date_in);
        return {
          id: i.id, number: i.invoice_number, rego: i.rego || '', dateIn: ymd(i.date_in), returnDate: ymd(i.return_date),
          total: round2(i.total_price), outstanding: round2(i.outstanding_amount),
          due, days: due ? diffDays(todayYmd, due) : null,
          emailed: !!i.account_emailed_at, emailedAt: i.account_emailed_at || null, emailedTo: i.account_emailed_to || null, emailedBy: i.account_emailed_by || null,
        };
      })
      .sort((a, b) => String(a.due).localeCompare(String(b.due)) || a.number - b.number);

    const overdue = unpaid.filter((i) => i.days < 0);
    const notDue = unpaid.filter((i) => i.days >= 0);
    const unsent = unpaid.filter((i) => !i.emailed);
    const oldest = unpaid[0] || null;
    const lp = lastPay.get(account.id) || null;
    out.push({
      account, unpaid,
      status: {
        owing: round2(unpaid.reduce((t, i) => t + i.outstanding, 0)),
        overdueAmt: round2(overdue.reduce((t, i) => t + i.outstanding, 0)),
        notDueAmt: round2(notDue.reduce((t, i) => t + i.outstanding, 0)),
        unsentCount: unsent.length,
        unsentAmt: round2(unsent.reduce((t, i) => t + i.outstanding, 0)),
        oldest, days: oldest ? oldest.days : null,
        bucket: !oldest ? 'paid' : oldest.days < 0 ? 'overdue' : 'upcoming',
        lastPaid: lp ? { date: ymd(lp.payment_date), amount: round2(lp.amount) } : null,
      },
    });
  }
  return out;
}

// ── Drafting ────────────────────────────────────────────────────────────────
async function insertDraft(db, row) {
  const exists = await db.prepare(`
    SELECT id FROM account_reminders WHERE account_customer_id = ? AND kind = ? AND rule_key = ? AND cycle_key = ? AND invoice_id = ?
  `).get(row.accountId, row.kind, row.ruleKey, row.cycleKey, row.invoiceId || 0);
  if (exists) return false;
  await db.prepare(`
    INSERT INTO account_reminders (carpark_id, account_customer_id, kind, rule_key, cycle_key, invoice_id, status)
    VALUES (?, ?, ?, ?, ?, ?, 'drafted')
  `).run(row.carparkId, row.accountId, row.kind, row.ruleKey, row.cycleKey, row.invoiceId || 0);
  return true;
}

/** Was a statement for this account and month already emailed (by any route)? */
async function statementAlreadySent(db, accountId, monthKey) {
  const r = await db.prepare(`
    SELECT 1 AS x FROM email_logs WHERE account_customer_id = ? AND month = ? AND year = ? AND status = 'sent'
      AND (customer_type = 'account' OR customer_type IS NULL) LIMIT 1
  `).get(accountId, parseInt(monthKey.slice(5, 7), 10), parseInt(monthKey.slice(0, 4), 10));
  return !!r;
}

/**
 * Creates the drafts that are due today, and retires drafts that no longer
 * apply (invoice emailed meanwhile, paid, etc.).
 * @returns {{created, cleared, held}} held = accounts whose statement is waiting on unsent invoices
 */
async function generateDrafts(db, { carparkId = 1, todayYmd }) {
  const settings = await getSettings(db, carparkId);
  const all = await loadAccountsWithStatus(db, { carparkId, todayYmd });
  const openRows = await db.prepare(`SELECT * FROM account_reminders WHERE carpark_id = ? AND status = 'drafted'`).all(carparkId);
  const stmtMonth = statementMonthFor(todayYmd);
  let created = 0;
  let cleared = 0;
  const held = [];
  const skip = async (id, why) => {
    await db.prepare(`UPDATE account_reminders SET status = 'skipped', note = COALESCE(note, ?) WHERE id = ?`).run(why, id);
    cleared++;
  };

  for (const { account, unpaid } of all) {
    const aid = account.id;
    const overdueEmailed = unpaid.filter((i) => i.days < 0 && i.emailed);
    const oldestOverdue = overdueEmailed[0] || null;
    const upcoming = unpaid.filter((i) => i.days >= 0 && i.emailed);
    const nextDueDate = upcoming.length ? upcoming[0].due : null;

    // 1) retire drafts that no longer apply
    for (const o of openRows.filter((r) => r.account_customer_id === aid)) {
      if (o.kind === 'invoice') {
        const inv = unpaid.find((i) => i.id === o.invoice_id);
        if (!inv) await skip(o.id, 'Paid or removed — no longer needed');
        else if (inv.emailed && o.rule_key !== 'manual') await skip(o.id, 'Already emailed');
      } else if (o.kind === 'statement') {
        if (!unpaid.length) await skip(o.id, 'Nothing unpaid — no longer needed');
        else if (o.rule_key !== 'manual' && await statementAlreadySent(db, aid, o.cycle_key)) await skip(o.id, 'Statement already sent');
      } else if (o.kind === 'early') {
        if (!upcoming.some((i) => i.due === o.cycle_key)) await skip(o.id, 'Paid — no longer needed');
      } else if (o.kind === 'overdue') {
        if (!oldestOverdue || oldestOverdue.due !== o.cycle_key) await skip(o.id, 'Paid or changed — no longer needed');
      }
    }

    // 2) one draft per unsent invoice
    if (settings.rules.invoice) {
      for (const inv of unpaid.filter((i) => !i.emailed)) {
        if (await insertDraft(db, { carparkId, accountId: aid, kind: 'invoice', ruleKey: 'invoice', cycleKey: 'once', invoiceId: inv.id })) created++;
      }
    }

    // 3) monthly statement — only once every invoice it lists has been emailed
    if (settings.rules.statement && stmtMonth) {
      const cutoff = endOfMonth(stmtMonth);
      const listed = unpaid.filter((i) => i.dateIn <= cutoff);
      if (listed.length && !(await statementAlreadySent(db, aid, stmtMonth))) {
        const blockers = listed.filter((i) => !i.emailed);
        if (blockers.length) held.push({ accountId: aid, name: account.company_name, unsent: blockers.length, month: stmtMonth });
        else if (await insertDraft(db, { carparkId, accountId: aid, kind: 'statement', ruleKey: 'statement', cycleKey: stmtMonth })) created++;
      }
    }

    // 4) overdue notice (latest stage reached) / friendly reminder
    let keep = null;
    if (oldestOverdue) {
      const stages = RULES.filter((r) => r.group === 'overdue' && settings.rules[r.key])
        .map((r) => ({ r, trigger: addCalendarDaysYmd(oldestOverdue.due, r.offset) }))
        .filter((x) => x.trigger <= todayYmd)
        .sort((a, b) => a.trigger.localeCompare(b.trigger));
      if (stages.length) {
        const pick = stages[stages.length - 1].r;
        keep = { kind: 'overdue', rule: pick.key, cycle: oldestOverdue.due };
        if (await insertDraft(db, { carparkId, accountId: aid, kind: 'overdue', ruleKey: pick.key, cycleKey: oldestOverdue.due })) created++;
      }
    }
    if (!keep && settings.rules.early && nextDueDate && todayYmd >= addCalendarDaysYmd(nextDueDate, -3) && todayYmd <= nextDueDate) {
      keep = { kind: 'early', rule: 'early', cycle: nextDueDate };
      if (await insertDraft(db, { carparkId, accountId: aid, kind: 'early', ruleKey: 'early', cycleKey: nextDueDate })) created++;
    }
    // a newer stage replaces an older unsent one (staff-requested 'manual' drafts are left alone)
    if (keep) {
      const rows = await db.prepare(`SELECT id, kind, rule_key, cycle_key FROM account_reminders WHERE account_customer_id = ? AND status = 'drafted' AND kind IN ('early','overdue')`).all(aid);
      for (const r of rows) {
        if (r.rule_key === 'manual') continue;
        if (r.kind !== keep.kind || r.rule_key !== keep.rule || r.cycle_key !== keep.cycle) await skip(r.id, 'Replaced by a newer reminder');
      }
    }
  }
  return { created, cleared, held };
}

/** Open drafts (snoozed ones hidden until their date), with what the review screen needs. */
async function listDrafts(db, { carparkId = 1, todayYmd }) {
  const drafts = await db.prepare(`
    SELECT * FROM account_reminders
    WHERE carpark_id = ? AND status = 'drafted' AND (snoozed_until IS NULL OR snoozed_until <= ?)
    ORDER BY created_at ASC, id ASC
  `).all(carparkId, todayYmd);
  const all = await loadAccountsWithStatus(db, { carparkId, todayYmd });
  const byId = new Map(all.map((x) => [x.account.id, x]));
  const out = [];
  for (const d of drafts) {
    const c = byId.get(d.account_customer_id);
    if (!c) continue;
    const { account, unpaid } = c;
    const email = billingEmail(account);
    const base = {
      id: d.id, kind: d.kind, ruleKey: d.rule_key, cycleKey: d.cycle_key, accountId: account.id,
      acct: account.account_number || '', name: account.company_name, contact: account.contact_name || '',
      email, hasEmail: !!email, note: d.note || null,
    };
    if (d.kind === 'invoice') {
      const inv = unpaid.find((i) => i.id === d.invoice_id);
      if (!inv) continue;
      out.push({ ...base, invoiceId: inv.id, invoiceNumber: inv.number, rego: inv.rego, dateIn: inv.dateIn, due: inv.due, days: inv.days, amount: inv.total,
        resend: inv.emailed, warning: email ? null : 'No billing email on file — add one on the account before this can be sent.' });
    } else if (d.kind === 'statement') {
      const cutoff = endOfMonth(d.cycle_key);
      const listed = unpaid.filter((i) => i.dateIn <= cutoff);
      if (!listed.length) continue;
      out.push({ ...base, month: d.cycle_key, monthLabel: monthLabel(d.cycle_key), count: listed.length, amount: round2(listed.reduce((t, i) => t + i.outstanding, 0)),
        unsent: listed.filter((i) => !i.emailed).length, days: null,
        warning: email ? (listed.some((i) => !i.emailed) ? `${listed.filter((i) => !i.emailed).length} of these invoices have not been emailed yet — send them first.` : null) : 'No billing email on file — add one on the account before this can be sent.' });
    } else if (d.kind === 'overdue') {
      const late = unpaid.filter((i) => i.days < 0 && i.emailed);
      if (!late.length) continue;
      out.push({ ...base, count: late.length, amount: round2(late.reduce((t, i) => t + i.outstanding, 0)), days: late[0].days, oldestDue: late[0].due,
        warning: email ? null : 'No billing email on file — add one on the account before this can be sent.' });
    } else if (d.kind === 'early') {
      const due = unpaid.filter((i) => i.days >= 0 && i.due === d.cycle_key && i.emailed);
      if (!due.length) continue;
      out.push({ ...base, count: due.length, amount: round2(due.reduce((t, i) => t + i.outstanding, 0)), days: due[0].days, oldestDue: d.cycle_key,
        warning: email ? null : 'No billing email on file — add one on the account before this can be sent.' });
    }
  }
  return out;
}

// ── The emails ──────────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n) => `$${(Number(n) || 0).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDate = (y) => {
  if (!y) return '';
  return new Date(`${ymd(y)}T00:00:00Z`).toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const shortDate = (y) => {
  if (!y) return '';
  return new Date(`${ymd(y)}T00:00:00Z`).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|[\s&(-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
const dayWord = (n) => `${n} day${n === 1 ? '' : 's'}`;

/** "Hi Dana" — the contact's first name, else the company name. */
function greetingName(account) {
  const c = String(account.contact_name || '').trim().split(/\s+/)[0];
  return titleCase(c || account.company_name || 'there');
}

function bankBlock(carpark, account, invoiceRef = null) {
  const ref = invoiceRef || account.account_number || account.company_name || '';
  const lines = [
    carpark && carpark.bank_name ? `<p style="margin:2px 0"><strong>Bank:</strong> ${esc(carpark.bank_name)}</p>` : '',
    carpark && carpark.bank_account_name ? `<p style="margin:2px 0"><strong>Account name:</strong> ${esc(carpark.bank_account_name)}</p>` : '',
    carpark && carpark.bank_account_number ? `<p style="margin:2px 0"><strong>Account number:</strong> ${esc(carpark.bank_account_number)}</p>` : '',
    `<p style="margin:2px 0"><strong>Reference:</strong> ${esc(invoiceRef ? `${invoiceRef} (your invoice number)` : (carpark && carpark.bank_reference ? `${carpark.bank_reference} — ${ref}` : ref))}</p>`,
  ].join('');
  const link = account.payment_link
    ? `<p><a href="${esc(account.payment_link)}" style="background:#27ae60;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;display:inline-block;margin-top:10px;">Pay Online</a></p>`
    : '';
  return `<p>Please pay by internet banking:</p>${lines}${link}`;
}

function shell({ carpark, account, intro, body, note }) {
  const name = carpark && carpark.name ? carpark.name : 'Car Storage';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;padding:20px;color:#333;line-height:1.55;">
  <h2 style="color:#1a5276;margin:0 0 14px;">${esc(name)}</h2>
  <p>Hi ${esc(greetingName(account))},</p>
  ${intro.map((t) => `<p>${esc(t)}</p>`).join('\n  ')}
  ${body}
  ${note ? `<p style="background:#fff8e6;border-radius:6px;padding:10px 12px;margin-top:16px;">${esc(note)}</p>` : ''}
  <p style="margin-top:20px;">Thanks,<br>${esc(name)}</p>
  <p style="color:#7f8c8d;font-size:12px;margin-top:18px;">${esc(carpark && carpark.address ? carpark.address : '')}<br>${esc(carpark && carpark.phone ? carpark.phone : '')}</p>
</body></html>`;
}

function invoiceRowsTable(rows, { showLate }) {
  const th = 'padding:8px 10px;text-align:left;background:#f2f7fa;font-size:12px;color:#52616e;';
  const td = 'padding:8px 10px;border-top:1px solid #dee2e6;font-size:13px;';
  return `<table style="width:100%;border-collapse:collapse;margin:14px 0;border:1px solid #dee2e6;">
    <tr><th style="${th}">Invoice</th><th style="${th}">Vehicle</th><th style="${th}">Issued</th><th style="${th}">Due</th>${showLate ? `<th style="${th}">Overdue</th>` : ''}<th style="${th}text-align:right;">Amount</th></tr>
    ${rows.map((i) => `<tr><td style="${td}"><strong>${esc(i.number)}</strong></td><td style="${td}">${esc(i.rego)}</td><td style="${td}">${esc(shortDate(i.dateIn))}</td><td style="${td}">${esc(shortDate(i.due))}</td>${showLate ? `<td style="${td}color:#9b1c11;font-weight:bold;">${dayWord(Math.abs(i.days))}</td>` : ''}<td style="${td}text-align:right;">${money(i.outstanding)}</td></tr>`).join('')}
  </table>`;
}

/** One invoice, on its own, with the PDF attached by the sender. */
function buildInvoiceEmail({ carpark, account, invoice, note }) {
  const due = invoiceDueYmd(invoice.date_in);
  const total = round2(invoice.total_price);
  const stay = [...new Set([shortDate(invoice.date_in), shortDate(invoice.return_date)].filter(Boolean))].join(' – ');
  const carparkName = carpark && carpark.name ? carpark.name : 'Car Storage';
  const subject = `Invoice ${invoice.invoice_number} from ${carparkName} — ${money(total)} due ${longDate(due)}${account.account_number ? ` (${account.account_number})` : ''}`;
  const td = 'padding:8px 12px;';
  const html = shell({
    carpark, account, note,
    intro: [`Please find invoice ${invoice.invoice_number} attached${invoice.rego ? ` for ${String(invoice.rego).toUpperCase()}` : ''}${stay ? ` (${stay})` : ''}. It will also appear on your monthly statement.`],
    body: `<table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f2f7fa;border-radius:8px;">
    <tr><td style="${td}"><strong>Invoice ${esc(invoice.invoice_number)}</strong></td><td style="${td}text-align:right;font-size:18px;"><strong>${money(total)}</strong></td></tr>
    <tr><td style="${td}border-top:1px solid #dee2e6;color:#666;">Issued</td><td style="${td}border-top:1px solid #dee2e6;text-align:right;color:#666;">${esc(longDate(invoice.date_in))}</td></tr>
    <tr><td style="${td}border-top:1px solid #dee2e6;"><strong>Due</strong></td><td style="${td}border-top:1px solid #dee2e6;text-align:right;"><strong>${esc(longDate(due))}</strong></td></tr>
  </table>
  ${bankBlock(carpark, account, String(invoice.invoice_number))}`,
  });
  return { subject, html, to: billingEmail(account), attachNames: [`Invoice-${invoice.invoice_number}.pdf`], total, due };
}

/** Overdue notice: every overdue invoice they have been sent, plus what is coming. */
function buildOverdueEmail({ carpark, account, unpaid, note, todayYmd }) {
  const late = unpaid.filter((i) => i.days < 0 && i.emailed);
  const coming = unpaid.filter((i) => i.days >= 0 && i.emailed);
  const total = round2(late.reduce((t, i) => t + i.outstanding, 0));
  const maxLate = late.length ? Math.abs(late[0].days) : 0;
  const name = titleCase(account.company_name);
  const subject = `${name}: ${late.length === 1 ? `invoice ${late[0].number}` : `${late.length} invoices`} overdue, ${money(total)}${account.account_number ? ` (${account.account_number})` : ''}`;
  const payBy = longDate(addCalendarDaysYmd(todayYmd, 7));
  const html = shell({
    carpark, account, note,
    intro: [`The ${late.length === 1 ? 'invoice' : 'invoices'} below on your account ${late.length === 1 ? 'is' : 'are'} past the due date (the 20th of the month after issue) — the oldest by ${dayWord(maxLate)}.`],
    body: `${invoiceRowsTable(late, { showLate: true })}
  <p style="font-size:16px;"><strong>Total overdue: ${money(total)}</strong></p>
  ${coming.length ? `<p style="color:#52616e;font-size:13px;">Also on your account, not yet due: ${coming.map((i) => `invoice ${esc(i.number)} (${money(i.outstanding)}, due ${esc(shortDate(i.due))})`).join(', ')}.</p>` : ''}
  <p>Please pay the overdue amount by ${esc(payBy)}.</p>
  ${bankBlock(carpark, account)}`,
  });
  return { subject, html, to: billingEmail(account), total, count: late.length, daysOverdue: maxLate };
}

/** Friendly reminder shortly before the 20th. */
function buildEarlyEmail({ carpark, account, unpaid, dueYmd, note }) {
  const rows = unpaid.filter((i) => i.days >= 0 && i.due === dueYmd && i.emailed);
  const total = round2(rows.reduce((t, i) => t + i.outstanding, 0));
  const subject = `Reminder: ${money(total)} due on ${longDate(dueYmd)}${account.account_number ? ` (${account.account_number})` : ''}`;
  const html = shell({
    carpark, account, note,
    intro: [`A friendly reminder that ${rows.length === 1 ? 'this invoice is' : 'these invoices are'} due on ${longDate(dueYmd)}.`],
    body: `${invoiceRowsTable(rows, { showLate: false })}
  <p style="font-size:16px;"><strong>Total due: ${money(total)}</strong></p>
  ${bankBlock(carpark, account)}`,
  });
  return { subject, html, to: billingEmail(account), total, count: rows.length };
}

/** Record that invoices were emailed to the account (so they stop showing as "not sent"). */
async function markInvoicesEmailed(db, invoiceIds, { to = null, by = 'staff' } = {}) {
  const ids = (invoiceIds || []).map(Number).filter(Boolean);
  if (!ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  const r = await db.prepare(`
    UPDATE invoices SET account_emailed_at = CURRENT_TIMESTAMP, account_emailed_to = ?, account_emailed_by = ?
    WHERE id IN (${ph}) AND account_customer_id IS NOT NULL
  `).run(to, by, ...ids);
  return r && r.changes != null ? r.changes : ids.length;
}

module.exports = {
  RULES, DEFAULT_RULES,
  invoiceDueYmd, statementMonthFor, endOfMonth, monthLabel, billingEmail, diffDays,
  getSettings, saveSettings, loadAccountsWithStatus,
  generateDrafts, listDrafts,
  buildInvoiceEmail, buildOverdueEmail, buildEarlyEmail, markInvoicesEmailed,
  titleCase, greetingName, money, longDate,
};
