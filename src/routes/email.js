const express = require('express');
const nodemailer = require('nodemailer');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const PDFDocument = require('pdfkit');
const { getAccountStatementData } = require('../utils/paymentAllocation');
const { buildInvoicePdfBuffer } = require('../utils/invoicePdf');
const router = express.Router();

const SMTP_MISSING_MSG =
  'Email is not configured. Set SMTP_USER and SMTP_PASS in the server environment (e.g. Railway or .env). For Gmail: use an App Password (Google Account → Security → 2-Step Verification → App passwords). Typical settings: SMTP_HOST=smtp.gmail.com SMTP_PORT=587 SMTP_SECURE=false';

const LONGTERM_MONTHLY_DEFAULT = 200.00;

function getTransporter() {
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim();
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    connectionTimeout: parseInt(process.env.SMTP_CONNECTION_TIMEOUT || '20000', 10),
    greetingTimeout: parseInt(process.env.SMTP_GREETING_TIMEOUT || '12000', 10),
    socketTimeout: parseInt(process.env.SMTP_SOCKET_TIMEOUT || '30000', 10),
    auth: { user, pass },
  });
}

function emailFrom() {
  const from = (process.env.EMAIL_FROM || '').trim();
  if (from) return from;
  const user = (process.env.SMTP_USER || '').trim();
  return user ? `BOI Car Storage <${user}>` : 'BOI Car Storage <noreply@localhost>';
}

function smtpErrorMessage(err) {
  const msg = String((err && err.message) || '');
  if (/535|badcredentials|invalid login|username and password not accepted/i.test(msg)) {
    return 'SMTP authentication failed (Gmail rejected login). Update SMTP_PASS to a current Gmail App Password, and ensure SMTP_USER matches that Gmail account.';
  }
  return msg || 'Email send failed';
}

function longTermGstAmounts(lt) {
  const GST_RATE = 0.15;
  const baseRaw = lt.contract_amount != null && lt.contract_amount !== '' ? lt.contract_amount : (lt.rate || LONGTERM_MONTHLY_DEFAULT);
  const base = parseFloat(baseRaw) || LONGTERM_MONTHLY_DEFAULT;
  const gst = Math.round((base * GST_RATE) * 100) / 100;
  const total = Math.round((base + gst) * 100) / 100;
  return { base, gst, total, rate: GST_RATE };
}

function dueDate20thNextMonth(month, year) {
  const m = parseInt(month, 10);
  const y = parseInt(year, 10);
  const nextMonth = m === 12 ? 1 : m + 1;
  const nextYear = m === 12 ? y + 1 : y;
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-20`;
}

function fmtYmd(d) {
  if (!d) return '';
  const s = String(d);
  // Accept ISO date or datetime.
  const ymd = s.length >= 10 ? s.slice(0, 10) : s;
  const dt = new Date(ymd + 'T00:00:00Z');
  if (Number.isNaN(dt.getTime())) return ymd;
  return dt.toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric' });
}

function accountInvoiceNumber(year, month2, accountId) {
  const y = String(year);
  const m = String(month2).padStart(2, '0');
  return `ACC-${y}${m}-${accountId}`;
}

function referenceForAccountInvoice(carpark, account, invoiceNo) {
  // Always use the generated invoice number as the bank reference.
  // This keeps it unique + searchable and avoids static/duplicate references.
  return invoiceNo;
}

function buildAccountEmailHTML(carpark, account, statementData, monthName, year, month2, dueDateYmd) {
  const { outstandingInvoices, grossInvoiced, totalPaid, totalOutstanding } = statementData;
  const rows = outstandingInvoices.map(inv => {
    const dIn  = inv.date_in     ? new Date(inv.date_in).toLocaleDateString('en-NZ',     { day: 'numeric', month: 'short', year: '2-digit' }) : '';
    const dOut = inv.return_date ? new Date(inv.return_date).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: '2-digit' }) : '';
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${dIn} – ${dOut}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${inv.first_name || ''} ${inv.last_name || ''}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${inv.rego || ''}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">$${parseFloat(inv.total_price || 0).toFixed(2)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:#27ae60;">$${inv.allocated_amount.toFixed(2)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:#c0392b;font-weight:bold;">$${inv.outstanding_amount.toFixed(2)}</td>
    </tr>`;
  }).join('');

  const payLink = account.payment_link
    ? `<p><a href="${account.payment_link}" style="background:#27ae60;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;display:inline-block;margin-top:10px;">Pay Online</a></p>`
    : '';

  const bank = [
    carpark.bank_name ? `<p><strong>Bank:</strong> ${carpark.bank_name}</p>` : '',
    carpark.bank_account_name ? `<p><strong>Account name:</strong> ${carpark.bank_account_name}</p>` : '',
    carpark.bank_account_number ? `<p><strong>Account number:</strong> ${carpark.bank_account_number}</p>` : '',
    (() => {
      const invNo = accountInvoiceNumber(year, month2, account.id);
      const ref = referenceForAccountInvoice(carpark, account, invNo);
      return `<p><strong>Invoice #:</strong> ${invNo}</p><p><strong>Reference:</strong> ${ref}</p>`;
    })(),
  ].join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
  <body style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:20px;color:#333;">
    <h2 style="color:#2c3e50;font-style:italic;">${carpark.name} – GST – ${monthName} ${year} Account Statement</h2>
    <hr style="border:2px solid #3498db;">
    <h3 style="color:#e74c3c;">${account.company_name}</h3>
    <p style="color:#555;font-size:13px;">Showing bookings with an outstanding balance. Fully paid bookings from this period aren't listed below.</p>
    <table style="width:100%;border-collapse:collapse;margin-top:10px;">
      <thead><tr style="background:#f8f9fa;">
        <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #dee2e6;">Stay</th>
        <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #dee2e6;">Name</th>
        <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #dee2e6;">Car Rego</th>
        <th style="padding:8px 10px;text-align:right;border-bottom:2px solid #dee2e6;">Cost</th>
        <th style="padding:8px 10px;text-align:right;border-bottom:2px solid #dee2e6;">Paid</th>
        <th style="padding:8px 10px;text-align:right;border-bottom:2px solid #dee2e6;">Outstanding</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:10px;color:#666;">Total invoiced this period: $${grossInvoiced.toFixed(2)} · Paid: $${totalPaid.toFixed(2)}</p>
    <p style="margin-top:4px;"><strong>Amount Outstanding: <span style="color:#c0392b;font-size:18px;">$${totalOutstanding.toFixed(2)}</span></strong></p>
    <p style="margin-top:4px;"><strong>Payment due date:</strong> 20th of next month (${dueDateYmd})</p>
    ${payLink}
    ${bank ? `<hr style="margin-top:22px;"><h3 style="color:#2c3e50;font-size:15px;">Payment details</h3>${bank}` : ''}
    <hr style="margin-top:30px;">
    <p style="color:#7f8c8d;font-size:12px;">${carpark.name}<br>${carpark.address || ''}<br>${carpark.phone || ''}<br>
    <em>This is an automated invoice. Please contact us if you have any queries.</em></p>
  </body></html>`;
}

function sanitizeFilename(s) {
  return String(s || '')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'account';
}

function buildAccountInvoicePDF({ res, carpark, account, statementData, monthName, year, month2, dueDateYmd }) {
  const { outstandingInvoices, grossInvoiced, totalPaid, totalOutstanding } = statementData;
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);

  const currency = (n) => `$${parseFloat(n || 0).toFixed(2)}`;
  const line = () => { doc.moveDown(0.4); doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#cccccc').stroke(); doc.moveDown(0.6); };
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const fullWidth = right - left;

  const invNo = accountInvoiceNumber(year, month2, account.id);

  doc.rect(left, doc.y, fullWidth, 56).fill('#1a5276');
  const headerY = doc.y + 12;
  doc.fillColor('#ffffff').fontSize(16).font('Helvetica-Bold')
    .text(carpark.name || 'Car Storage Yard', left + 12, headerY, { width: fullWidth - 24 });
  doc.fontSize(10).font('Helvetica')
    .text(`Account statement — ${monthName} ${year}`, left + 12, headerY + 22, { width: fullWidth - 24 });
  doc.y += 64;

  doc.fillColor('#2c3e50').fontSize(10).text(`Invoice #: ${invNo}`);
  doc.text(`Payment due: 20th of next month (${dueDateYmd})`);
  line();

  doc.fontSize(14).fillColor('#c0392b').font('Helvetica-Bold').text(account.company_name || '');
  doc.font('Helvetica').fontSize(9).fillColor('#666').text('Showing bookings with an outstanding balance. Fully paid bookings from this period are not listed.');
  doc.moveDown(0.5);

  // Table header
  const startX = doc.page.margins.left;
  let y = doc.y;
  const col = { stay: startX, name: startX + 120, rego: startX + 250, cost: startX + 320, paid: startX + 390, out: startX + 460 };
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#000').text('Stay', col.stay, y, { width: 110 });
  doc.text('Name', col.name, y, { width: 125 });
  doc.text('Rego', col.rego, y, { width: 65 });
  doc.text('Cost', col.cost, y, { width: 65, align: 'right' });
  doc.text('Paid', col.paid, y, { width: 65, align: 'right' });
  doc.text('Outstanding', col.out, y, { width: 75, align: 'right' });
  doc.font('Helvetica');
  y += 14;
  doc.moveTo(startX, y).lineTo(doc.page.width - doc.page.margins.right, y).strokeColor('#e0e0e0').stroke();
  y += 8;

  const fmtShort = (d) => d ? new Date(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: '2-digit' }) : '';
  for (const inv of outstandingInvoices) {
    const stay = `${fmtShort(inv.date_in)} – ${fmtShort(inv.return_date)}`.trim();
    const name = `${inv.first_name || ''} ${inv.last_name || ''}`.trim();
    const rego = inv.rego || '';

    doc.fontSize(8).fillColor('#111').text(stay, col.stay, y, { width: 110 });
    doc.text(name, col.name, y, { width: 125 });
    doc.text(rego, col.rego, y, { width: 65 });
    doc.text(currency(inv.total_price), col.cost, y, { width: 65, align: 'right' });
    doc.fillColor('#27ae60').text(currency(inv.allocated_amount), col.paid, y, { width: 65, align: 'right' });
    doc.fillColor('#c0392b').font('Helvetica-Bold').text(currency(inv.outstanding_amount), col.out, y, { width: 75, align: 'right' });
    doc.font('Helvetica').fillColor('#111');
    y += 14;

    if (y > doc.page.height - doc.page.margins.bottom - 140) {
      doc.addPage();
      y = doc.y;
    }
  }

  doc.y = y;
  doc.moveDown(1);
  doc.fontSize(9).fillColor('#666').text(`Total invoiced this period: ${currency(grossInvoiced)}   ·   Paid: ${currency(totalPaid)}`, { align: 'right' });
  doc.moveDown(0.3);
  doc.fontSize(14).fillColor('#c0392b').font('Helvetica-Bold').text(`Amount Outstanding: ${currency(totalOutstanding)}`, { align: 'right' });
  doc.font('Helvetica').fillColor('#1a5276').moveDown(0.8);
  line();

  // Payment details
  // Anchor to left margin so it never "sticks" on the right after right-aligned totals.
  doc.x = left;
  doc.fontSize(12).fillColor('#2c3e50').text('Payment details', left, doc.y, { width: fullWidth, align: 'left' });
  doc.moveDown(0.4);
  doc.fontSize(10).fillColor('#111');
  const ref = referenceForAccountInvoice(carpark, account, invNo);
  const rows = [
    carpark.bank_name ? `Bank: ${carpark.bank_name}` : null,
    carpark.bank_account_name ? `Account name: ${carpark.bank_account_name}` : null,
    carpark.bank_account_number ? `Account number: ${carpark.bank_account_number}` : null,
    `Invoice #: ${invNo}`,
    `Reference: ${ref}`,
  ].filter(Boolean);
  // Render full-width, left aligned (wraps naturally across the page).
  rows.forEach(r => doc.text(r, left, doc.y, { width: fullWidth, align: 'left' }));

  doc.moveDown(1.2);
  doc.fontSize(9).fillColor('#777').text(`${carpark.address || ''}\n${carpark.phone || ''}`.trim());
  doc.end();
}

function billingEmail(account) {
  return String(account?.billing_email || account?.email || '').trim();
}

function recipientKey(account) {
  const email = billingEmail(account);
  if (email) return `email:${email.toLowerCase()}`;
  return `name:${String(account?.company_name || '').trim().toLowerCase()}`;
}

// GET /api/email/preview
router.get('/preview', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { month, year } = req.query;
    const m = String(month || new Date().getMonth() + 1).padStart(2, '0');
    const y = year || new Date().getFullYear();
    const startDate = `${y}-${m}-01`;
    const endDate   = new Date(y, parseInt(m), 0).toISOString().split('T')[0];
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthName  = monthNames[parseInt(m) - 1];
    const dueDateYmd = dueDate20thNextMonth(parseInt(m, 10), parseInt(y, 10));
    const carpark    = await db.prepare('SELECT * FROM carparks WHERE id = ?').get(carparkId);
    const accounts   = await db.prepare('SELECT * FROM account_customers WHERE carpark_id = ? AND active = 1').all(carparkId);

    // Group accounts so the same recipient doesn't get multiple separate preview blocks.
    // Keyed by billing email (fallback: company name).
    const byKey = new Map(); // key -> { account, account_ids: [], invoices: [], total }

    for (const account of accounts) {
      const invoices = await db.prepare(`
        SELECT * FROM invoices
        WHERE account_customer_id = ?
          AND void = 0
          AND DATE(date_in) >= ?
          AND DATE(date_in) <= ?
        ORDER BY date_in ASC
      `).all(account.id, startDate, endDate);

      if (invoices.length === 0) continue;

      const key = recipientKey(account);
      if (!byKey.has(key)) {
        byKey.set(key, { account, account_ids: [account.id], invoices: [], total: 0 });
      }

      const g = byKey.get(key);
      g.account_ids.push(account.id);
      g.invoices.push(...invoices);
      g.total += invoices.reduce((s, inv) => s + (inv.payment_amount || 0), 0);

      // Prefer an account that has a billing email for the same group.
      if (!billingEmail(g.account) && billingEmail(account)) g.account = account;
    }

    const accountData = Array.from(byKey.values()).map(g => {
      g.invoices.sort((a, b) => new Date(a.date_in).getTime() - new Date(b.date_in).getTime());
      return { account: g.account, account_ids: g.account_ids, invoices: g.invoices, total: g.total };
    });

    res.json({ month: m, year: y, monthName, dueDate: dueDateYmd, carpark, accounts: accountData });
  } catch (err) { res.status(500).json({ error: smtpErrorMessage(err) }); }
});

// GET /api/email/account-invoice.pdf?month=MM&year=YYYY&account_ids=1,2,3
router.get('/account-invoice.pdf', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { month, year, account_ids } = req.query;
    const m = String(month || new Date().getMonth() + 1).padStart(2, '0');
    const y = year || new Date().getFullYear();
    const startDate = `${y}-${m}-01`;
    const endDate   = new Date(y, parseInt(m), 0).toISOString().split('T')[0];
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthName  = monthNames[parseInt(m) - 1];
    const dueDateYmd = dueDate20thNextMonth(parseInt(m, 10), parseInt(y, 10));

    const ids = typeof account_ids === 'string' ? account_ids.split(',') : (Array.isArray(account_ids) ? account_ids : []);
    const normalizedIds = ids.map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0);
    if (normalizedIds.length === 0) return res.status(400).json({ error: 'account_ids required' });

    const carpark = await db.prepare('SELECT * FROM carparks WHERE id = ?').get(carparkId);
    const ph = normalizedIds.map(() => '?').join(',');
    const accounts = await db.prepare(`SELECT * FROM account_customers WHERE id IN (${ph}) AND carpark_id = ? AND active = 1`).all(...normalizedIds, carparkId);
    if (!accounts || accounts.length === 0) return res.status(404).json({ error: 'Account not found' });

    // Pick a representative account for the PDF title (same as email grouping logic)
    let account = accounts[0];
    for (const a of accounts) {
      if (!billingEmail(account) && billingEmail(a)) account = a;
    }

    const statementData = await getAccountStatementData(db, { carparkId, accountIds: normalizedIds, startDate, endDate });
    if (!statementData.allInvoices || statementData.allInvoices.length === 0) return res.status(404).json({ error: 'No invoices for this month' });

    const invNo = accountInvoiceNumber(y, m, account.id);
    const filename = `${sanitizeFilename(carpark?.name)}_${sanitizeFilename(account?.company_name)}_${invNo}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

    buildAccountInvoicePDF({ res, carpark: carpark || {}, account, statementData, monthName, year: y, month2: m, dueDateYmd });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/email/send-accounts
router.post('/send-accounts', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { month, year, account_ids } = req.body;
    const m = String(month || new Date().getMonth() + 1).padStart(2, '0');
    const y = year || new Date().getFullYear();
    const startDate = `${y}-${m}-01`;
    const endDate   = new Date(y, parseInt(m), 0).toISOString().split('T')[0];
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthName  = monthNames[parseInt(m) - 1];
    const dueDateYmd = dueDate20thNextMonth(parseInt(m, 10), parseInt(y, 10));
    const carpark    = await db.prepare('SELECT * FROM carparks WHERE id = ?').get(carparkId);

    let accounts;
    const ids = Array.isArray(account_ids)
      ? account_ids
      : (typeof account_ids === 'string' ? account_ids.split(',') : []);
    const normalizedIds = ids.map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0);
    if (normalizedIds.length === 0) {
      return res.status(400).json({ error: 'Select at least one account to send' });
    }
    const ph = normalizedIds.map(() => '?').join(',');
    accounts = await db.prepare(`SELECT * FROM account_customers WHERE id IN (${ph}) AND carpark_id = ? AND active = 1`).all(...normalizedIds, carparkId);

    const transporter = getTransporter();
    if (!transporter) return res.status(503).json({ error: SMTP_MISSING_MSG });
    const results = [];

    // Group accounts by recipient so duplicate company entries don't produce multiple emails.
    const byKey = new Map(); // key -> { account, account_ids: [] }
    for (const account of accounts) {
      const key = recipientKey(account);
      if (!byKey.has(key)) {
        byKey.set(key, { account, account_ids: [account.id] });
      } else {
        const g = byKey.get(key);
        g.account_ids.push(account.id);
        if (!billingEmail(g.account) && billingEmail(account)) g.account = account;
      }
    }

    for (const g of Array.from(byKey.values())) {
      const accountIds = g.account_ids;
      const statementData = await getAccountStatementData(db, { carparkId, accountIds, startDate, endDate });

      if (statementData.allInvoices.length === 0) {
        results.push({ account: g.account.company_name, status: 'skipped', reason: 'No invoices this month' });
        continue;
      }
      if (statementData.outstandingInvoices.length === 0) {
        results.push({ account: g.account.company_name, status: 'skipped', reason: 'Already paid in full' });
        continue;
      }

      const emailTo = billingEmail(g.account);
      if (!emailTo) {
        results.push({ account: g.account.company_name, status: 'failed', reason: 'No billing email' });
        await db.prepare(`INSERT INTO email_logs (carpark_id, account_customer_id, account_name, month, year, status, error_msg, recipient_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(carparkId, g.account.id, g.account.company_name, parseInt(m), parseInt(y), 'failed', 'No billing email', '');
        continue;
      }

      const html = buildAccountEmailHTML(carpark, g.account, statementData, monthName, y, m, dueDateYmd);
      const total = statementData.totalOutstanding;
      try {
        const invNo = accountInvoiceNumber(y, m, g.account.id);

        // Attach each outstanding booking's own invoice PDF alongside the
        // statement, so the customer has a full paper trail per booking —
        // not just the summary. A failure generating one attachment doesn't
        // block the email — the statement itself is the essential part.
        const attachments = [];
        for (const inv of statementData.outstandingInvoices) {
          try {
            const buf = await buildInvoicePdfBuffer(inv, carpark);
            attachments.push({ filename: `Invoice-${inv.invoice_number}.pdf`, content: buf });
          } catch (pdfErr) {
            console.error(`[send-accounts] Failed to build PDF for invoice #${inv.invoice_number}:`, pdfErr.message);
          }
        }

        await transporter.sendMail({
          from: emailFrom(),
          to: emailTo,
          subject: `${carpark.name} – GST – ${monthName} ${y} Account Invoice (${invNo})`,
          html,
          attachments,
        });
        results.push({ account: g.account.company_name, status: 'sent', email: emailTo, total });
        await db.prepare(`INSERT INTO email_logs (carpark_id, account_customer_id, account_name, month, year, sent_at, status, recipient_email) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`)
          .run(carparkId, g.account.id, g.account.company_name, parseInt(m), parseInt(y), 'sent', emailTo);
      } catch (sendErr) {
        results.push({ account: g.account.company_name, status: 'failed', reason: sendErr.message });
        await db.prepare(`INSERT INTO email_logs (carpark_id, account_customer_id, account_name, month, year, status, error_msg, recipient_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(carparkId, g.account.id, g.account.company_name, parseInt(m), parseInt(y), 'failed', sendErr.message, emailTo);
      }
    }
    res.json({ success: true, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/email/logs
router.get('/logs', requireAuth, async (req, res) => {
  try {
    const logs = await db.prepare('SELECT * FROM email_logs WHERE carpark_id = ? ORDER BY sent_at DESC LIMIT 100').all(req.session.carparkId || 1);
    res.json(logs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/email/logs/:id
router.delete('/logs/:id', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid log id' });
    const result = await db.prepare('DELETE FROM email_logs WHERE id = ? AND carpark_id = ?').run(id, carparkId);
    if (!result || !result.changes) return res.status(404).json({ error: 'Log not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/email/logs
router.delete('/logs', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const result = await db.prepare('DELETE FROM email_logs WHERE carpark_id = ?').run(carparkId);
    res.json({ success: true, deleted: result && Number.isFinite(result.changes) ? result.changes : 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/email/receipt/:invoiceId  – send an individual invoice receipt
router.post('/receipt/:invoiceId', requireAuth, async (req, res) => {
  const { invoiceId } = req.params;
  const carparkId = req.session.carparkId || 1;
  try {
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ? AND carpark_id = ?').get(invoiceId, carparkId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const emailTo = invoice.email;
    if (!emailTo) return res.status(400).json({ error: 'No email address on this invoice' });

    const carpark = await db.prepare('SELECT * FROM carparks WHERE id = ?').get(carparkId);
    const ltMatch = invoice.rego
      ? await db.prepare(`
          SELECT id, lt_number
          FROM longterm_customers
          WHERE carpark_id = ? AND active = 1
            AND (UPPER(TRIM(COALESCE(rego_1,''))) = UPPER(?) OR UPPER(TRIM(COALESCE(rego_2,''))) = UPPER(?))
          LIMIT 1
        `).get(carparkId, invoice.rego, invoice.rego)
      : null;

    const fmt = (d) => d ? new Date(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
    const currency = (n) => `$${parseFloat(n || 0).toFixed(2)}`;
    const GST_RATE = 0.15;
    const totalInc = parseFloat(invoice.total_price || 0) || 0;
    const gstAmt = ltMatch ? (totalInc - (totalInc / (1 + GST_RATE))) : 0;
    const baseExGst = ltMatch ? (totalInc - gstAmt) : 0;

    const paymentRows = `
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee;"><strong>Payment</strong></td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;">${invoice.paid_status || '—'}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${currency(invoice.payment_amount)}</td></tr>
      ${invoice.payment_amount_2 > 0 ? `
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee;"><strong>2nd Payment</strong></td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;">${invoice.paid_status_2 || '—'}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${currency(invoice.payment_amount_2)}</td></tr>` : ''}
    `;

    // Clear paid/owing status — the same "at a glance" banner used on the PDF.
    const amountPaid = Math.round((
      (parseFloat(invoice.payment_amount) || 0) +
      (parseFloat(invoice.payment_amount_2) || 0) +
      (parseFloat(invoice.credit_applied) || 0)
    ) * 100) / 100;
    const amountOwing = Math.max(0, Math.round(((parseFloat(invoice.total_price) || 0) - amountPaid) * 100) / 100);
    const isPaidInFull = amountOwing <= 0.01 && (invoice.paid_status && invoice.paid_status !== 'To Pay');
    const statusBannerHtml = `
      <div style="background:${isPaidInFull ? '#1e8449' : '#c0392b'};color:#fff;text-align:center;padding:12px;border-radius:6px;margin:16px 0;font-size:16px;font-weight:bold;">
        ${isPaidInFull ? 'PAID IN FULL' : `AMOUNT DUE: ${currency(amountOwing)}`}
      </div>`;

    const transporterEarly = getTransporter();
    if (!transporterEarly) return res.status(503).json({ error: SMTP_MISSING_MSG });

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;padding:20px;color:#333;">
  <div style="background:#2c3e50;color:#fff;padding:20px;border-radius:8px 8px 0 0;text-align:center;">
    <h1 style="margin:0;font-size:22px;">${carpark ? carpark.name : 'Car Storage Yard'}</h1>
    <p style="margin:4px 0 0;font-size:13px;opacity:.8;">${carpark ? carpark.address || '' : ''}</p>
  </div>
  <div style="background:#f8f9fa;border:1px solid #dee2e6;border-top:none;padding:20px;border-radius:0 0 8px 8px;">
    <h2 style="color:#2c3e50;margin-top:0;">Receipt / Invoice #${invoice.invoice_number}</h2>

    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
      <tr><td style="padding:5px 0;width:140px;color:#666;">Customer</td>
          <td style="padding:5px 0;font-weight:bold;">${invoice.first_name || ''} ${invoice.last_name || ''}</td></tr>
      <tr><td style="padding:5px 0;color:#666;">Vehicle Rego</td>
          <td style="padding:5px 0;font-weight:bold;">${invoice.rego || '—'}</td></tr>
      <tr><td style="padding:5px 0;color:#666;">Key #</td>
          <td style="padding:5px 0;">${invoice.no_key ? 'No Key' : (invoice.key_number || '—')}</td></tr>
      <tr><td style="padding:5px 0;color:#666;">Date In</td>
          <td style="padding:5px 0;">${fmt(invoice.date_in)}${invoice.time_in ? ' at ' + invoice.time_in : ''}</td></tr>
      <tr><td style="padding:5px 0;color:#666;">Return Date</td>
          <td style="padding:5px 0;">${fmt(invoice.return_date)}${invoice.return_time ? ' at ' + invoice.return_time : ''}</td></tr>
      <tr><td style="padding:5px 0;color:#666;">Stay</td>
          <td style="padding:5px 0;">${invoice.stay_nights || 0} night(s)</td></tr>
      ${invoice.flight_info ? `<tr><td style="padding:5px 0;color:#666;">Flight</td>
          <td style="padding:5px 0;">${invoice.flight_info} (${invoice.flight_type || ''})</td></tr>` : ''}
    </table>

    <hr style="border:1px solid #dee2e6;margin:16px 0;">

    <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
      ${ltMatch ? `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">Long-term base (ex GST)</td><td></td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${currency(baseExGst)}</td></tr>` : ''}
      ${ltMatch ? `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">GST (15%)</td><td></td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${currency(gstAmt)}</td></tr>` : ''}
      ${invoice.discount_percent > 0 ? `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">Discount</td><td></td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:#e74c3c;">-${invoice.discount_percent}%</td></tr>` : ''}
      ${invoice.credit_applied > 0  ? `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">Credit Applied</td><td></td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:#3498db;">${currency(invoice.credit_applied)}</td></tr>` : ''}
      <tr style="background:#f8f9fa;"><td style="padding:10px;font-size:16px;font-weight:bold;" colspan="2">TOTAL</td>
          <td style="padding:10px;font-size:18px;font-weight:bold;color:#27ae60;text-align:right;">${currency(invoice.total_price)}</td></tr>
    </table>

    ${statusBannerHtml}

    <table style="width:100%;border-collapse:collapse;">
      ${paymentRows}
    </table>

    ${invoice.notes ? `<p style="margin-top:16px;padding:10px;background:#fff3cd;border-radius:4px;font-size:13px;"><strong>Notes:</strong> ${invoice.notes}</p>` : ''}

    <hr style="border:1px solid #dee2e6;margin:20px 0 10px;">
    <p style="color:#7f8c8d;font-size:12px;text-align:center;margin:0;">
      Thank you for choosing ${carpark ? carpark.name : 'our Car Storage Yard'}<br>
      ${carpark ? carpark.phone || '' : ''}
    </p>
  </div>
</body></html>`;

    await transporterEarly.sendMail({
      from: emailFrom(),
      to: emailTo,
      subject: `Receipt – ${carpark ? carpark.name : 'Car Storage'} – Invoice #${invoice.invoice_number}`,
      html,
    });

    res.json({ success: true, message: `Receipt sent to ${emailTo}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function longTermEmailHTML(carpark, lt, kind) {
  const currency = (n) => `$${parseFloat(n || 0).toFixed(2)}`;
  const gst = longTermGstAmounts(lt);
  const startDate = lt?.contract_start_date ? fmtYmd(lt.contract_start_date) : (lt?.created_at ? fmtYmd(lt.created_at) : '');
  const expiryDate = lt?.expiry_date ? fmtYmd(lt.expiry_date) : '';
  const bank = [
    carpark.bank_name ? `<p><strong>Bank:</strong> ${carpark.bank_name}</p>` : '',
    carpark.bank_account_name ? `<p><strong>Account name:</strong> ${carpark.bank_account_name}</p>` : '',
    carpark.bank_account_number ? `<p><strong>Account number:</strong> ${carpark.bank_account_number}</p>` : '',
    carpark.bank_reference ? `<p><strong>Reference:</strong> ${carpark.bank_reference} — ${lt.lt_number}</p>` : `<p><strong>Reference:</strong> ${lt.lt_number}</p>`,
  ].join('');

  if (kind === 'payment') {
    const now = new Date();
    const dueDateYmd = dueDate20thNextMonth(now.getMonth() + 1, now.getFullYear());
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;padding:20px;color:#333;">
  <h2 style="color:#2c3e50;">${carpark.name} – Long-term payment due</h2>
  <p>Hi ${lt.name},</p>
  <p>Please arrange payment for your long-term storage contract <strong>${lt.lt_number}</strong>.</p>
  <p><strong>Payment due:</strong> by the 20th (${dueDateYmd}).</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f8f9fa;border-radius:8px;">
    <tr><td style="padding:12px;"><strong>Amount due</strong></td><td style="padding:12px;text-align:right;font-size:18px;color:#c0392b;">${currency(gst.total)}</td></tr>
    <tr><td style="padding:12px;border-top:1px solid #dee2e6;">Amount ex GST</td><td style="padding:12px;border-top:1px solid #dee2e6;text-align:right;">${currency(gst.base)}</td></tr>
    <tr><td style="padding:12px;border-top:1px solid #dee2e6;">GST (${Math.round(gst.rate * 100)}%)</td><td style="padding:12px;border-top:1px solid #dee2e6;text-align:right;">${currency(gst.gst)}</td></tr>
    ${startDate ? `<tr><td style="padding:12px;border-top:1px solid #dee2e6;">Contract start</td><td style="padding:12px;border-top:1px solid #dee2e6;text-align:right;">${startDate}</td></tr>` : ''}
    ${expiryDate ? `<tr><td style="padding:12px;border-top:1px solid #dee2e6;">Contract expiry</td><td style="padding:12px;border-top:1px solid #dee2e6;text-align:right;">${expiryDate}</td></tr>` : ''}
  </table>
  <h3 style="color:#2c3e50;font-size:15px;">Payment details</h3>
  ${bank || '<p>Please contact us for bank transfer details.</p>'}
  <p style="color:#7f8c8d;font-size:12px;margin-top:24px;">${carpark.address || ''}<br>${carpark.phone || ''}</p>
</body></html>`;
  }

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;padding:20px;color:#333;">
  <h2 style="color:#27ae60;">${carpark.name} – Payment received (thank you)</h2>
  <p>Hi ${lt.name},</p>
  <p>Thank you — we have recorded payment for long-term contract <strong>${lt.lt_number}</strong>.</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#ecf9f1;border-radius:8px;">
    <tr><td style="padding:12px;"><strong>Recorded amount</strong></td><td style="padding:12px;text-align:right;font-size:18px;color:#27ae60;">${currency(gst.total)}</td></tr>
    <tr><td style="padding:12px;border-top:1px solid #c8e6c9;">Amount ex GST</td><td style="padding:12px;border-top:1px solid #c8e6c9;text-align:right;">${currency(gst.base)}</td></tr>
    <tr><td style="padding:12px;border-top:1px solid #c8e6c9;">GST (${Math.round(gst.rate * 100)}%)</td><td style="padding:12px;border-top:1px solid #c8e6c9;text-align:right;">${currency(gst.gst)}</td></tr>
    <tr><td style="padding:12px;border-top:1px solid #c8e6c9;">Status</td><td style="padding:12px;border-top:1px solid #c8e6c9;text-align:right;">${lt.payment_status || 'Paid'}</td></tr>
    ${startDate ? `<tr><td style="padding:12px;border-top:1px solid #c8e6c9;">Contract start</td><td style="padding:12px;border-top:1px solid #c8e6c9;text-align:right;">${startDate}</td></tr>` : ''}
    ${expiryDate ? `<tr><td style="padding:12px;border-top:1px solid #c8e6c9;">Contract expiry</td><td style="padding:12px;border-top:1px solid #c8e6c9;text-align:right;">${expiryDate}</td></tr>` : ''}
  </table>
  <p style="color:#7f8c8d;font-size:12px;margin-top:24px;">${carpark.address || ''}<br>${carpark.phone || ''}</p>
</body></html>`;
}

// POST /api/email/longterm/:id/payment-request
router.post('/longterm/:id/payment-request', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const lt = await db.prepare('SELECT * FROM longterm_customers WHERE id = ? AND carpark_id = ?').get(req.params.id, carparkId);
    if (!lt) return res.status(404).json({ error: 'Long-term customer not found' });
    const emailTo = (lt.email || '').trim();
    if (!emailTo) return res.status(400).json({ error: 'No email on this long-term customer' });
    const carpark = await db.prepare('SELECT * FROM carparks WHERE id = ?').get(carparkId);
    const transporter = getTransporter();
    if (!transporter) return res.status(503).json({ error: SMTP_MISSING_MSG });
    await transporter.sendMail({
      from: emailFrom(),
      to: emailTo,
      subject: `${carpark ? carpark.name : 'Car Storage'} – Payment due (${lt.lt_number})`,
      html: longTermEmailHTML(carpark || {}, lt, 'payment'),
    });
    res.json({ success: true, message: `Payment request sent to ${emailTo}` });
  } catch (err) {
    const msg = /timed?out/i.test(String(err.message || ''))
      ? 'SMTP connection timeout. Check Railway SMTP env vars and outbound connection.'
      : smtpErrorMessage(err);
    res.status(500).json({ error: msg });
  }
});

// GET /api/email/longterm/:id/preview?type=payment|receipt
router.get('/longterm/:id/preview', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const kind = String(req.query.type || 'payment').toLowerCase() === 'receipt' ? 'receipt' : 'payment';
    const lt = await db.prepare('SELECT * FROM longterm_customers WHERE id = ? AND carpark_id = ?').get(req.params.id, carparkId);
    if (!lt) return res.status(404).json({ error: 'Long-term customer not found' });
    const carpark = await db.prepare('SELECT * FROM carparks WHERE id = ?').get(carparkId);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(longTermEmailHTML(carpark || {}, lt, kind));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/email/longterm/:id/receipt  (confirmation / receipt email)
router.post('/longterm/:id/receipt', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const lt = await db.prepare('SELECT * FROM longterm_customers WHERE id = ? AND carpark_id = ?').get(req.params.id, carparkId);
    if (!lt) return res.status(404).json({ error: 'Long-term customer not found' });
    const emailTo = (lt.email || '').trim();
    if (!emailTo) return res.status(400).json({ error: 'No email on this long-term customer' });
    const carpark = await db.prepare('SELECT * FROM carparks WHERE id = ?').get(carparkId);
    const transporter = getTransporter();
    if (!transporter) return res.status(503).json({ error: SMTP_MISSING_MSG });
    await transporter.sendMail({
      from: emailFrom(),
      to: emailTo,
      subject: `${carpark ? carpark.name : 'Car Storage'} – Payment confirmation (${lt.lt_number})`,
      html: longTermEmailHTML(carpark || {}, lt, 'receipt'),
    });
    res.json({ success: true, message: `Receipt / confirmation sent to ${emailTo}` });
  } catch (err) {
    const msg = /timed?out/i.test(String(err.message || ''))
      ? 'SMTP connection timeout. Check Railway SMTP env vars and outbound connection.'
      : smtpErrorMessage(err);
    res.status(500).json({ error: msg });
  }
});

// POST /api/email/test
router.post('/test', requireAuth, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const transporter = getTransporter();
    if (!transporter) return res.status(503).json({ error: SMTP_MISSING_MSG });
    await transporter.sendMail({
      from: emailFrom(),
      to: email,
      subject: 'Carpark System – Test Email',
      html: '<h2>✅ Test Email</h2><p>Your email configuration is working correctly.</p><p>Sent from BOI Car Storage system.</p>'
    });
    res.json({ success: true, message: `Test email sent to ${email}` });
  } catch (err) {
    res.status(500).json({ error: smtpErrorMessage(err) });
  }
});

module.exports = router;
module.exports.buildAccountEmailHTML = buildAccountEmailHTML;
