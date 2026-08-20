const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { EFFECTIVE_PAY1_DAY, EFFECTIVE_PAY2_DAY } = require('../utils/invoicePaymentDates');
const { getInvoiceOutstanding, autoConfirmIBIfAccountPaid } = require('../utils/paymentAllocation');
const { logActivity, actorFromReq } = require('../utils/audit');
const router = express.Router();
const round2 = (n) => Math.round((n || 0) * 100) / 100;

router.get('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { from, to } = req.query;
    const today = new Date().toISOString().split('T')[0];
    const fromDate = from || new Date(new Date().setDate(1)).toISOString().split('T')[0];
    const toDate = to || today;
    const records = await db.prepare(`SELECT b.*, u.name as staff_name FROM banking b LEFT JOIN users u ON b.staff_id = u.id WHERE b.carpark_id = ? AND b.date >= ? AND b.date <= ? ORDER BY b.date DESC`).all(carparkId, fromDate, toDate);
    const summary = await db.prepare(`SELECT COALESCE(SUM(eftpos_total),0) as eftpos, COALESCE(SUM(cash_total),0) as cash, COALESCE(SUM(account_total),0) as account, COALESCE(SUM(other_total),0) as other FROM banking WHERE carpark_id = ? AND date >= ? AND date <= ?`).get(carparkId, fromDate, toDate);
    res.json({ records, summary, fromDate, toDate });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { date, eftpos_total, cash_total, account_total, other_total, notes } = req.body;
    const d = date || new Date().toISOString().split('T')[0];
    const { userId, userName } = actorFromReq(req);
    const existingFull = await db.prepare('SELECT * FROM banking WHERE carpark_id = ? AND date = ?').get(carparkId, d);
    if (existingFull) {
      await db.prepare(`UPDATE banking SET eftpos_total=?, cash_total=?, account_total=?, other_total=?, notes=?, staff_id=? WHERE id=?`)
        .run(eftpos_total || 0, cash_total || 0, account_total || 0, other_total || 0, notes, req.session.userId, existingFull.id);
      const record = await db.prepare('SELECT * FROM banking WHERE id = ?').get(existingFull.id);
      await logActivity(db, {
        carparkId, tableName: 'banking', recordId: existingFull.id, action: 'update',
        before: existingFull, after: record, userId, userName,
      });
      return res.json(record);
    }
    const result = await db.prepare(`INSERT INTO banking (carpark_id, date, eftpos_total, cash_total, account_total, other_total, notes, staff_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(carparkId, d, eftpos_total || 0, cash_total || 0, account_total || 0, other_total || 0, notes, req.session.userId);
    const record = await db.prepare('SELECT * FROM banking WHERE id = ?').get(result.lastInsertRowid);
    await logActivity(db, {
      carparkId, tableName: 'banking', recordId: record.id, action: 'create',
      before: null, after: record, userId, userName,
    });
    res.status(201).json(record);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/banking/autofill?date=YYYY-MM-DD
// Builds banking fields from invoice payment lines posted on the selected date.
// payment_date_1/payment_date_2 are set when a "To Pay" line becomes a real payment.
router.get('/autofill', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const rows = await db.prepare(`
      SELECT
        paid_status, payment_amount, payment_date_1, date_in,
        paid_status_2, payment_amount_2, payment_date_2
      FROM invoices
      WHERE carpark_id = ? AND void = 0
        AND (
          (${EFFECTIVE_PAY1_DAY}) = ?
          OR ((${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) = ?)
        )
    `).all(carparkId, date, date);

    let eftpos = 0;
    let cash = 0;
    let account = 0;
    let other = 0;
    let creditRedeemed = 0;

    const addByStatus = (statusRaw, amountRaw) => {
      const status = String(statusRaw || '').trim();
      const amount = parseFloat(amountRaw || 0) || 0;
      if (amount <= 0) return;
      if (status === 'Eftpos') eftpos += amount;
      else if (status === 'Cash') cash += amount;
      // Not real money received on the day the invoice was made — On Account
      // only counts once actually paid (via account_payments below), and
      // Internet Banking only once confirmed (see ibRows below). Counting
      // either here too would double-count once the real payment lands.
      else if (status === 'OnAcc') return;
      else if (status === 'Internet Banking') return;
      // Customer Credit isn't physical money received today — it's value the
      // customer already paid for on an earlier visit. Track separately so
      // it doesn't inflate what actually needs to go to the bank/till.
      else if (status === 'Customer Credit') creditRedeemed += amount;
      else if (status && status !== 'To Pay') other += amount;
    };

    const day = String(date).trim();
    const eff1 = (r) => {
      const p = String(r.payment_date_1 || '').trim().slice(0, 10);
      if (p) return p;
      return String(r.date_in || '').trim().slice(0, 10);
    };
    const eff2 = (r) => {
      const a2 = parseFloat(r.payment_amount_2 || 0) || 0;
      const s2 = String(r.paid_status_2 || '').trim();
      if (a2 <= 0 || !s2 || s2 === 'To Pay') return '';
      const p = String(r.payment_date_2 || '').trim().slice(0, 10);
      if (p) return p;
      return String(r.date_in || '').trim().slice(0, 10);
    };
    for (const r of rows) {
      if (eff1(r) === day) addByStatus(r.paid_status, r.payment_amount);
      if (eff2(r) === day) addByStatus(r.paid_status_2, r.payment_amount_2);
    }

    // Long-term prepayments — attribute by cash_received_date (the day the money
    // actually arrived), NOT payment_date (which may be a future recognition
    // month for prorated prepays). Without this, LT cash never showed up here.
    const ltRows = await db.prepare(`
      SELECT payment_method, amount_ex_gst, cash_received_date, payment_date
      FROM longterm_payments
      WHERE carpark_id = ?
        AND substr(trim(COALESCE(NULLIF(trim(cash_received_date), ''), payment_date)), 1, 10) = ?
    `).all(carparkId, day);
    for (const r of ltRows) addByStatus(r.payment_method, r.amount_ex_gst);

    // Account-customer payments — attribute by payment_date. Creating this
    // row IS the confirmation (staff only records it once they've actually
    // received it), so no separate confirmation step needed here.
    const acctRows = await db.prepare(`
      SELECT payment_method, amount, payment_date
      FROM account_payments
      WHERE carpark_id = ? AND substr(trim(COALESCE(payment_date, '')), 1, 10) = ?
    `).all(carparkId, day);
    for (const r of acctRows) addByStatus(r.payment_method, r.amount);

    // Confirmed Internet Banking — attributed to the day a staff member
    // actually confirmed it landed (ib_confirmed_at), not the day the
    // booking was made. Unconfirmed IB never appears here at all.
    const ibRows = await db.prepare(`
      SELECT
        (CASE WHEN paid_status = 'Internet Banking' AND ib_confirmed = 1 AND substr(trim(COALESCE(ib_confirmed_at,'')),1,10) = ? THEN COALESCE(payment_amount,0) ELSE 0 END) +
        (CASE WHEN paid_status_2 = 'Internet Banking' AND ib_confirmed_2 = 1 AND substr(trim(COALESCE(ib_confirmed_2_at,'')),1,10) = ? THEN COALESCE(payment_amount_2,0) ELSE 0 END)
        AS amt
      FROM invoices
      WHERE carpark_id = ? AND void = 0
        AND ((paid_status = 'Internet Banking' AND ib_confirmed = 1) OR (paid_status_2 = 'Internet Banking' AND ib_confirmed_2 = 1))
    `).all(day, day, carparkId);
    for (const r of ibRows) other += parseFloat(r.amt) || 0;

    res.json({
      date,
      eftpos: round2(eftpos),
      cash: round2(cash),
      account: round2(account),
      other: round2(other),
      creditRedeemed: round2(creditRedeemed),
      total: round2(eftpos + cash + account + other)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/banking/pending-internet-banking
// Every Internet Banking payment recorded on an invoice that hasn't been
// confirmed yet (i.e. nobody has checked the bank statement and verified it
// actually landed). One row per pending slot — an invoice split across two
// payment methods could have both, rarely, so they're confirmed independently.
router.get('/pending-internet-banking', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const rows = await db.prepare(`
      SELECT i.id, i.invoice_number, i.first_name, i.last_name, i.rego, i.date_in,
        1 AS slot, i.payment_amount AS amount, i.staff_code_name,
        i.account_customer_id, ac.company_name AS account_name
      FROM invoices i
      LEFT JOIN account_customers ac ON i.account_customer_id = ac.id
      WHERE i.carpark_id = ? AND i.void = 0 AND i.paid_status = 'Internet Banking'
        AND COALESCE(i.ib_confirmed,0) = 0 AND COALESCE(i.payment_amount,0) > 0
      UNION ALL
      SELECT i.id, i.invoice_number, i.first_name, i.last_name, i.rego, i.date_in,
        2 AS slot, i.payment_amount_2 AS amount, i.staff_code_name,
        i.account_customer_id, ac.company_name AS account_name
      FROM invoices i
      LEFT JOIN account_customers ac ON i.account_customer_id = ac.id
      WHERE i.carpark_id = ? AND i.void = 0 AND i.paid_status_2 = 'Internet Banking'
        AND COALESCE(i.ib_confirmed_2,0) = 0 AND COALESCE(i.payment_amount_2,0) > 0
      ORDER BY date_in ASC
    `).all(carparkId, carparkId);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/banking/pending-internet-banking/auto-confirm-preview
// Read-only: which currently-pending Internet Banking slots would be
// auto-confirmed because the invoice is also an account-customer invoice
// that's already been fully paid off via the Accounts allocation ledger.
// Shown to staff before they trigger the actual sweep below.
router.get('/pending-internet-banking/auto-confirm-preview', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const rows = await db.prepare(`
      SELECT id, invoice_number, first_name, last_name, rego, date_in,
        1 AS slot, payment_amount AS amount, account_customer_id
      FROM invoices
      WHERE carpark_id = ? AND void = 0 AND paid_status = 'Internet Banking'
        AND COALESCE(ib_confirmed,0) = 0 AND COALESCE(payment_amount,0) > 0
        AND account_customer_id IS NOT NULL
      UNION ALL
      SELECT id, invoice_number, first_name, last_name, rego, date_in,
        2 AS slot, payment_amount_2 AS amount, account_customer_id
      FROM invoices
      WHERE carpark_id = ? AND void = 0 AND paid_status_2 = 'Internet Banking'
        AND COALESCE(ib_confirmed_2,0) = 0 AND COALESCE(payment_amount_2,0) > 0
        AND account_customer_id IS NOT NULL
      ORDER BY date_in ASC
    `).all(carparkId, carparkId);

    const qualifying = [];
    for (const r of rows) {
      const outstanding = await getInvoiceOutstanding(db, r.id);
      if (outstanding <= 0.01) qualifying.push(r);
    }
    const total = round2(qualifying.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0));
    res.json({ qualifying, total, checked: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/banking/pending-internet-banking/auto-confirm
// Actually runs the sweep: auto-confirms every pending Internet Banking
// slot that qualifies (see preview above). Safe to re-run — anything that
// no longer qualifies (or is already confirmed) is simply skipped.
router.post('/pending-internet-banking/auto-confirm', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const rows = await db.prepare(`
      SELECT DISTINCT id FROM invoices
      WHERE carpark_id = ? AND void = 0 AND account_customer_id IS NOT NULL
        AND (
          (paid_status = 'Internet Banking' AND COALESCE(ib_confirmed,0) = 0 AND COALESCE(payment_amount,0) > 0)
          OR (paid_status_2 = 'Internet Banking' AND COALESCE(ib_confirmed_2,0) = 0 AND COALESCE(payment_amount_2,0) > 0)
        )
    `).all(carparkId);
    let confirmedCount = 0;
    for (const r of rows) {
      const did = await autoConfirmIBIfAccountPaid(db, { carparkId, invoiceId: r.id });
      if (did) confirmedCount++;
    }
    res.json({ success: true, checked: rows.length, confirmed: confirmedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/banking/confirm-internet-banking/:invoiceId  { slot: 1|2 }
// Marks one Internet Banking payment slot as confirmed — the moment staff
// verify the transfer actually arrived in the bank statement. From this
// point on it counts as real revenue everywhere (Dashboard, Reports, Banking,
// End Day), attributed to today's date, not the original booking date.
router.post('/confirm-internet-banking/:invoiceId', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const invoiceId = req.params.invoiceId;
    const slot = parseInt(req.body.slot, 10) === 2 ? 2 : 1;
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ? AND carpark_id = ?').get(invoiceId, carparkId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const status = slot === 2 ? invoice.paid_status_2 : invoice.paid_status;
    if (String(status || '').trim() !== 'Internet Banking') {
      return res.status(400).json({ error: `Payment slot ${slot} on this invoice is not Internet Banking` });
    }

    const staffName = (req.session.name || req.session.username || 'Unknown').trim();
    if (slot === 2) {
      await db.prepare(`UPDATE invoices SET ib_confirmed_2 = 1, ib_confirmed_2_at = CURRENT_TIMESTAMP, ib_confirmed_2_by = ? WHERE id = ?`)
        .run(staffName, invoiceId);
    } else {
      await db.prepare(`UPDATE invoices SET ib_confirmed = 1, ib_confirmed_at = CURRENT_TIMESTAMP, ib_confirmed_by = ? WHERE id = ?`)
        .run(staffName, invoiceId);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/petty-cash', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { from, to } = req.query;
    const today = new Date().toISOString().split('T')[0];
    const fromDate = from || new Date(new Date().setDate(1)).toISOString().split('T')[0];
    const toDate = to || today;
    const records = await db.prepare(`SELECT pc.*, u.name as staff_name FROM petty_cash pc LEFT JOIN users u ON pc.staff_id = u.id WHERE pc.carpark_id = ? AND pc.date >= ? AND pc.date <= ? ORDER BY pc.date DESC, pc.id DESC`).all(carparkId, fromDate, toDate);
    const summary = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END), 0) as income, COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END), 0) as expense FROM petty_cash WHERE carpark_id = ? AND date >= ? AND date <= ?`).get(carparkId, fromDate, toDate);
    res.json({ records, summary, fromDate, toDate });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/petty-cash', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { date, description, amount, type, category } = req.body;
    const result = await db.prepare(`INSERT INTO petty_cash (carpark_id, date, description, amount, type, category, staff_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(carparkId, date || new Date().toISOString().split('T')[0], description, amount, type, category, req.session.userId);
    const record = await db.prepare('SELECT * FROM petty_cash WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(record);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/petty-cash/:id', requireAuth, async (req, res) => {
  try {
    await db.prepare('DELETE FROM petty_cash WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
