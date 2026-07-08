require('dotenv').config({ path: './config.env' });
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const path = require('path');
const cron = require('node-cron');

const { db, initializeDatabase } = require('./src/database');
const { getSessionSecret } = require('./src/utils/config');

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
          const invoices = await db.prepare(`
            SELECT * FROM invoices WHERE account_customer_id = ? AND void = 0
            AND DATE(date_in) >= ? AND DATE(date_in) <= ?
            ORDER BY date_in ASC
          `).all(account.id, startDate, endDate);

          if (invoices.length === 0) continue;

          const emailTo = account.billing_email || account.email;
          if (!emailTo) continue;

          const total = invoices.reduce((s, inv) => s + (inv.payment_amount || 0), 0);
          const rows  = invoices.map(inv => {
            const dIn  = inv.date_in     ? new Date(inv.date_in).toLocaleDateString('en-NZ',     { day:'numeric', month:'short', year:'2-digit' }) : '';
            const dOut = inv.return_date ? new Date(inv.return_date).toLocaleDateString('en-NZ', { day:'numeric', month:'short', year:'2-digit' }) : '';
            return `<tr><td>${dIn} - ${dOut}</td><td>${inv.first_name||''} ${inv.last_name||''}</td><td>${inv.rego||''}</td><td>$${parseFloat(inv.payment_amount||0).toFixed(2)}</td></tr>`;
          }).join('');

          const paymentLink = account.payment_link
            ? `<p><a href="${account.payment_link}" style="background:#27ae60;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;">Pay Online</a></p>`
            : '';

        const invNo = `ACC-${year}${m}-${account.id}`;
        const ref = invNo;
        const bank = [
            carpark.bank_name ? `<p><strong>Bank:</strong> ${carpark.bank_name}</p>` : '',
            carpark.bank_account_name ? `<p><strong>Account name:</strong> ${carpark.bank_account_name}</p>` : '',
            carpark.bank_account_number ? `<p><strong>Account number:</strong> ${carpark.bank_account_number}</p>` : '',
          `<p><strong>Invoice #:</strong> ${invNo}</p>`,
          `<p><strong>Reference:</strong> ${ref}</p>`,
          ].join('');

          const html = `<!DOCTYPE html><html><body style="font-family:Arial;max-width:700px;margin:0 auto;padding:20px;">
            <h2 style="color:#2c3e50;font-style:italic;">${carpark.name} - GST - ${monthName} ${year} Account Invoice</h2><hr>
            <h3 style="color:#e74c3c;">${account.company_name}</h3>
            <table border="1" cellpadding="8" cellspacing="0" width="100%">
              <tr><th>Stay</th><th>Name</th><th>Car Rego</th><th>Cost</th></tr>${rows}
            </table>
            <p><strong>Total: <span style="color:#27ae60;">$${parseFloat(total).toFixed(2)}</span></strong></p>
            <p><strong>Payment due date:</strong> 20th of next month (${dueDateYmd})</p>
            ${paymentLink}
            ${bank ? `<hr><h3 style="color:#2c3e50;font-size:15px;">Payment details</h3>${bank}` : ''}
          </body></html>`;

          try {
            await transporter.sendMail({
              from: process.env.EMAIL_FROM || `BOI Car Storage <boicarparkkerikeri@gmail.com>`,
              to:   emailTo,
            subject: `${carpark.name} - GST - ${monthName} ${year} Account Invoice (${invNo})`,
              html
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
        // Monthly Long-term invoices (default monthly plan: $200 ex GST)
        const ltCustomers = await db.prepare('SELECT * FROM longterm_customers WHERE carpark_id = ? AND active = 1').all(carpark.id);
        for (const lt of ltCustomers) {
          const emailTo = String(lt.email || '').trim();
          if (!emailTo) continue;
          const baseExGst = 200.00;
          const gstAmt = Math.round((baseExGst * 0.15) * 100) / 100;
          const total = Math.round((baseExGst + gstAmt) * 100) / 100;
          const html = `<!DOCTYPE html><html><body style="font-family:Arial;max-width:700px;margin:0 auto;padding:20px;">
            <h2 style="color:#2c3e50;font-style:italic;">${carpark.name} - Long-term Monthly Payment</h2><hr>
            <p>Hi ${lt.name || ''},</p>
            <p>This is your monthly long-term storage invoice for <strong>${monthName} ${year}</strong>.</p>
            <table border="1" cellpadding="8" cellspacing="0" width="100%">
              <tr><th>Plan</th><th>Amount ex GST</th><th>GST (15%)</th><th>Total</th></tr>
              <tr><td>Monthly</td><td>$${baseExGst.toFixed(2)}</td><td>$${gstAmt.toFixed(2)}</td><td><strong>$${total.toFixed(2)}</strong></td></tr>
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
