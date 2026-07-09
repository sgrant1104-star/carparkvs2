require('dotenv').config({ path: './config.env' });
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const path = require('path');
const cron = require('node-cron');

const { db, initializeDatabase } = require('./src/database');
const { getSessionSecret } = require('./src/utils/config');
const { getAccountStatementData } = require('./src/utils/paymentAllocation');
const { buildInvoicePdfBuffer } = require('./src/utils/invoicePdf');
const { buildAccountEmailHTML } = require('./src/routes/email');

const app = express();

// ─── Lazy DB initialisation ──────────────────────────────────────────────────
// On Vercel, module.exports is consumed before initializeDatabase() resolves,
// so we gate every request behind a single shared init promise.
let _dbInitPromise = null;
app.use((req, res, next) => {
  if (!_dbInitPromise) {
    _dbInitPromise = initializeDatabase().catch(err => {
      console.error('DB init failed:', err);
      _dbInitPromise = null; // allow retry on next request
      throw err;
    });
  }
  _dbInitPromise.then(() => next()).catch(() => {
    res.status(500).json({ error: 'Database initialisation failed. Please try again.' });
  });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── JWT session middleware ───────────────────────────────────────────────────
// Reads the signed JWT from the 'auth_token' httpOnly cookie and populates
// req.session so all existing route code (req.session.userId etc.) works
// unchanged.  No server-side state → works perfectly on Vercel serverless.
// We deliberately do NOT set the Secure cookie flag: Vercel's edge network
// already enforces HTTPS at the CDN layer, so there is no HTTP to protect
// against, and omitting Secure avoids the "secure cookie over HTTP" error that
// cookie-session threw when the internal serverless connection appeared as HTTP.
const JWT_SECRET = getSessionSecret();
app.use((req, res, next) => {
  req.session = {}; // always a plain object so req.session.x never throws
  const token = req.cookies && req.cookies.auth_token;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.session.userId    = decoded.userId;
      req.session.username  = decoded.username;
      req.session.name      = decoded.name;
      req.session.role      = decoded.role;
      req.session.carparkId = decoded.carparkId;
    } catch (_) {
      // expired / tampered → req.session stays empty, treated as logged-out
    }
  }
  next();
});

// Serve static files – disable caching so browsers always get latest JS/HTML
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
}));

// API Routes
app.use('/api/auth',      require('./src/routes/auth'));
app.use('/api/dashboard', require('./src/routes/dashboard'));
app.use('/api/invoices',  require('./src/routes/invoices'));
app.use('/api/returns',   require('./src/routes/returns'));
app.use('/api/customers', require('./src/routes/customers'));
app.use('/api/longterm',  require('./src/routes/longterm'));
app.use('/api/accounts',  require('./src/routes/accounts'));
app.use('/api/keybox',    require('./src/routes/keybox'));
app.use('/api/reports',   require('./src/routes/reports'));
app.use('/api/email',     require('./src/routes/email'));
app.use('/api/banking',   require('./src/routes/banking'));
app.use('/api/admin',     require('./src/routes/admin'));
app.use('/api/endday',    require('./src/routes/endday'));
app.use('/api/flights',   require('./src/routes/flights'));

// ─── Diagnostic endpoint (no auth – safe, read-only) ─────────────────────────
app.get('/api/status', async (req, res) => {
  try {
    const invoiceCount = await db.prepare('SELECT COUNT(*) as c FROM invoices WHERE void = 0').get();
    const keyInUse     = await db.prepare("SELECT COUNT(*) as c FROM key_box WHERE status = 'in_use'").get();
    const keyAvail     = await db.prepare("SELECT COUNT(*) as c FROM key_box WHERE status = 'available'").get();
    res.json({
      mode: 'sql.js (file-backed SQLite)',
      db_path: process.env.VERCEL ? '/tmp/carpark.db' : 'carpark.db',
      db_stats: { invoices: invoiceCount.c, keys_in_use: keyInUse.c, keys_available: keyAvail.c }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin: re-seed DB ────────────────────────────────────────────────────────
app.post('/api/admin/reset-db', async (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const dbModule = require('./src/database');
    await dbModule.resetDatabase();
    res.json({ success: true, message: 'Database reset. Refresh the app.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Root redirect
app.get('/', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect('/menu.html');
  }
  res.redirect('/login.html');
});

async function runMonthEndEmailJob({ force = false, includeAccounts = true, includeLongTerm = true } = {}) {
  console.log(`Running month-end account/LT email job${force ? ' (manual force)' : ''}...`);
  try {
    const nodemailer = require('nodemailer');

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const isLastDayOfMonth = tomorrow.getMonth() !== now.getMonth();
    if (!force && !isLastDayOfMonth) {
      console.log('Month-end email job skipped: not last day of month.');
      return { skipped: true, reason: 'not_last_day' };
    }

    const month = now.getMonth() + 1;
    const year  = now.getFullYear();
    const m     = String(month).padStart(2, '0');
    const startDate = `${year}-${m}-01`;
    const endDate   = new Date(year, month, 0).toISOString().split('T')[0];
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const dueDateYmd = `${nextYear}-${String(nextMonth).padStart(2, '0')}-20`;
    const monthNames = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];
    const monthName = monthNames[month - 1];

    const carparks = await db.prepare('SELECT * FROM carparks').all();

    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    if (!smtpUser || !smtpPass) {
      console.warn('[email] SMTP_USER / SMTP_PASS not set — skipping month-end email job. Set these in the environment to enable emailing.');
      return { skipped: true, reason: 'smtp_not_configured' };
    }

    for (const carpark of carparks) {
      const accounts = await db.prepare('SELECT * FROM account_customers WHERE carpark_id = ? AND active = 1').all(carpark.id);

      const transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
        port:   parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth:   { user: smtpUser, pass: smtpPass }
      });

      if (includeAccounts) {
        for (const account of accounts) {
          const statementData = await getAccountStatementData(db, {
            carparkId: carpark.id, accountIds: [account.id], startDate, endDate,
          });

          if (statementData.allInvoices.length === 0) continue;
          if (statementData.outstandingInvoices.length === 0) {
            console.log(`[month-end email] Skipping ${account.company_name} — already paid in full for ${monthName} ${year}.`);
            continue;
          }

          const emailTo = account.billing_email || account.email;
          if (!emailTo) continue;

          const invNo = `ACC-${year}${m}-${account.id}`;
          const html = buildAccountEmailHTML(carpark, account, statementData, monthName, year, m, dueDateYmd);

          const attachments = [];
          for (const inv of statementData.outstandingInvoices) {
            try {
              const buf = await buildInvoicePdfBuffer(inv, carpark);
              attachments.push({ filename: `Invoice-${inv.invoice_number}.pdf`, content: buf });
            } catch (pdfErr) {
              console.error(`[month-end email] Failed to build PDF for invoice #${inv.invoice_number}:`, pdfErr.message);
            }
          }

          try {
            await transporter.sendMail({
              from: process.env.EMAIL_FROM || `BOI Car Storage <boicarparkkerikeri@gmail.com>`,
              to:   emailTo,
              subject: `${carpark.name} - GST - ${monthName} ${year} Account Invoice (${invNo})`,
              html,
              attachments,
            });
            await db.prepare(`INSERT INTO email_logs
              (carpark_id, account_customer_id, account_name, month, year, sent_at, status, recipient_email)
              VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`)
              .run(carpark.id, account.id, account.company_name, month, year, 'sent', emailTo);
            console.log(`Sent account email to ${emailTo}`);
          } catch (err) {
            console.error(`Failed to send to ${emailTo}:`, err.message);
            await db.prepare(`INSERT INTO email_logs
              (carpark_id, account_customer_id, account_name, month, year, status, error_msg, recipient_email)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(carpark.id, account.id, account.company_name, month, year, 'failed', err.message, emailTo);
          }
        }
      }

      if (includeLongTerm) {
        // Monthly Long-term invoices
        const ltCustomers = await db.prepare('SELECT * FROM longterm_customers WHERE carpark_id = ? AND active = 1').all(carpark.id);
        for (const lt of ltCustomers) {
          const emailTo = String(lt.email || '').trim();
          if (!emailTo) continue;

          // Skip if the contract has already ended — no ongoing obligation to bill.
          if (lt.expiry_date && String(lt.expiry_date).slice(0, 10) < startDate) {
            console.log(`[month-end email] Skipping ${lt.name} — contract expired ${lt.expiry_date}.`);
            continue;
          }

          // Skip if this recognition month is already covered — checks against
          // payment_date (the accrual month), which correctly accounts for
          // prepaid/prorated contracts as well as month-by-month payers.
          const monthlyRate = lt.rate && parseFloat(lt.rate) > 0 ? parseFloat(lt.rate) : 200.00;
          const monthPaidRow = await db.prepare(`
            SELECT COALESCE(SUM(amount_ex_gst), 0) AS paid
            FROM longterm_payments
            WHERE carpark_id = ? AND longterm_customer_id = ?
              AND substr(trim(COALESCE(payment_date,'')),1,10) >= ? AND substr(trim(COALESCE(payment_date,'')),1,10) <= ?
          `).get(carpark.id, lt.id, startDate, endDate);
          const paidForMonth = parseFloat(monthPaidRow?.paid || 0);
          if (paidForMonth >= monthlyRate - 0.01) {
            console.log(`[month-end email] Skipping ${lt.name} — already paid for ${monthName} ${year} ($${paidForMonth.toFixed(2)}).`);
            continue;
          }

          const baseExGst = Math.max(0, monthlyRate - paidForMonth);
          const gstAmt = Math.round((baseExGst * 0.15) * 100) / 100;
          const total = Math.round((baseExGst + gstAmt) * 100) / 100;
          const html = `<!DOCTYPE html><html><body style="font-family:Arial;max-width:700px;margin:0 auto;padding:20px;">
            <h2 style="color:#2c3e50;font-style:italic;">${carpark.name} - Long-term Monthly Payment</h2><hr>
            <p>Hi ${lt.name || ''},</p>
            <p>This is your monthly long-term storage invoice for <strong>${monthName} ${year}</strong>.</p>
            <table border="1" cellpadding="8" cellspacing="0" width="100%">
              <tr><th>Plan</th><th>Amount ex GST</th><th>GST (15%)</th><th>Total</th></tr>
              <tr><td>Monthly${paidForMonth > 0 ? ' (balance owing)' : ''}</td><td>$${baseExGst.toFixed(2)}</td><td>$${gstAmt.toFixed(2)}</td><td><strong>$${total.toFixed(2)}</strong></td></tr>
            </table>
            <p><strong>Payment due:</strong> by the 20th (${dueDateYmd})</p>
            <p style="color:#666;">Reference: ${lt.lt_number || ''}</p>
          </body></html>`;
          try {
            await transporter.sendMail({
              from: process.env.EMAIL_FROM || `BOI Car Storage <boicarparkkerikeri@gmail.com>`,
              to: emailTo,
              subject: `${carpark.name} - Long-term Monthly Invoice (${monthName} ${year})`,
              html
            });
          } catch (err) {
            console.error(`Failed LT monthly send to ${emailTo}:`, err.message);
          }
        }
      }
    }
    console.log('Month-end account/LT emails completed.');
    return { success: true };
  } catch (err) {
    console.error('Cron job error:', err);
    throw err;
  }
}

// ─── Scheduled job: send month-end account/LT emails at 8 AM ──────────────────
// Runs on days 28-31, but only executes on the last calendar day of the month.
cron.schedule('0 8 28-31 * *', async () => {
  try {
    await runMonthEndEmailJob({ force: false });
  } catch (_) {
    // already logged in runMonthEndEmailJob
  }
});

// ─── Admin: manually trigger month-end email run now ───────────────────────────
app.post('/api/admin/run-month-end-emails', async (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const includeAccounts = req.body && req.body.includeAccounts === true;
    const includeLongTerm = req.body && req.body.includeLongTerm === true;
    if (!includeAccounts && !includeLongTerm) {
      return res.status(400).json({ error: 'Choose includeAccounts and/or includeLongTerm' });
    }
    const result = await runMonthEndEmailJob({ force: true, includeAccounts, includeLongTerm });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to run month-end emails' });
  }
});

// ─── Local dev: start the HTTP server ────────────────────────────────────────
// On Vercel this file is imported as a module; app.listen() must NOT be called.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  initializeDatabase().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n================================================`);
      console.log(`  BOI Car Storage - Carpark Management System`);
      console.log(`  Running at: http://0.0.0.0:${PORT}`);
      console.log(`================================================\n`);
    });
  }).catch(err => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
}

// Export for Vercel (and tests)
module.exports = app;
