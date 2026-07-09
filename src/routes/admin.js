const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { getSessionSecret } = require('../utils/config');
const router = express.Router();

const JWT_SECRET = () => getSessionSecret();
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 8 * 60 * 60 * 1000,
};

// GET /api/admin/activity-log?table=invoices&record_id=123&from=&to=&limit=200
// Audit trail viewer — who changed/voided/deleted what, and what it looked
// like before/after. Admin-only since it can contain full row snapshots.
router.get('/activity-log', requireAuth, requireAdmin, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { table, record_id, from, to, action } = req.query;
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 200);

    const clauses = ['carpark_id = ?'];
    const params = [carparkId];
    if (table) { clauses.push('table_name = ?'); params.push(table); }
    if (record_id) { clauses.push('record_id = ?'); params.push(record_id); }
    if (action) { clauses.push('action = ?'); params.push(action); }
    if (from) { clauses.push("date(created_at) >= date(?)"); params.push(from); }
    if (to) { clauses.push("date(created_at) <= date(?)"); params.push(to); }

    const rows = await db.prepare(`
      SELECT * FROM activity_log
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `).all(...params);

    const parsed = rows.map(r => ({
      ...r,
      before: r.before_json ? JSON.parse(r.before_json) : null,
      after: r.after_json ? JSON.parse(r.after_json) : null,
    }));
    res.json(parsed);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await db.prepare('SELECT id, username, name, email, role, active, created_at FROM users WHERE carpark_id = ?').all(req.session.carparkId || 1);
    res.json(users);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { username, password, name, email, role, active } = req.body;
    const existing = await db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return res.status(400).json({ error: 'Username already exists' });
    const hash = bcrypt.hashSync(password, 10);
    const isActive = active === true || active === 1 || active === '1';
    const result = await db.prepare(`INSERT INTO users (username, password, name, email, role, active, carpark_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(username, hash, name, email, role || 'staff', isActive ? 1 : 0, carparkId);
    const user = await db.prepare('SELECT id, username, name, email, role, active FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { username, name, email, role, active, password } = req.body;
    const isActive = active === true || active === 1 || active === '1';

    // If username is being changed, ensure it is unique
    if (username) {
      const existing = await db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.params.id);
      if (existing) return res.status(400).json({ error: 'Username already exists' });
    }

    if (password) {
      const hash = bcrypt.hashSync(password, 10);
      await db.prepare('UPDATE users SET username=?, name=?, email=?, role=?, active=?, password=? WHERE id=?')
        .run(username, name, email, role, isActive ? 1 : 0, hash, req.params.id);
    } else {
      await db.prepare('UPDATE users SET username=?, name=?, email=?, role=?, active=? WHERE id=?')
        .run(username, name, email, role, isActive ? 1 : 0, req.params.id);
    }
    const user = await db.prepare('SELECT id, username, name, email, role, active FROM users WHERE id = ?').get(req.params.id);
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/carparks', requireAuth, requireAdmin, async (req, res) => {
  try {
    const carparks = await db.prepare('SELECT * FROM carparks').all();
    res.json(carparks);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/carparks/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, address, phone, email, capacity, bank_name, bank_account_name, bank_account_number, bank_reference } = req.body;
    await db.prepare(`UPDATE carparks SET name=?, address=?, phone=?, email=?, capacity=?,
      bank_name=?, bank_account_name=?, bank_account_number=?, bank_reference=? WHERE id=?`)
      .run(name, address, phone, email, capacity, bank_name||null, bank_account_name||null, bank_account_number||null, bank_reference||null, req.params.id);
    const carpark = await db.prepare('SELECT * FROM carparks WHERE id = ?').get(req.params.id);
    res.json(carpark);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/pricing', requireAuth, requireAdmin, async (req, res) => {
  try {
    const rules = await db.prepare('SELECT * FROM pricing_rules WHERE carpark_id = ? ORDER BY customer_type, days_from').all(req.session.carparkId || 1);
    res.json(rules);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/pricing', requireAuth, requireAdmin, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { customer_type, days_from, days_to, daily_rate, description } = req.body;
    const result = await db.prepare(`INSERT INTO pricing_rules (carpark_id, customer_type, days_from, days_to, daily_rate, description) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(carparkId, customer_type, days_from, days_to || null, daily_rate, description);
    const rule = await db.prepare('SELECT * FROM pricing_rules WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(rule);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/pricing/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { days_from, days_to, daily_rate, description, active } = req.body;
    await db.prepare('UPDATE pricing_rules SET days_from=?, days_to=?, daily_rate=?, description=?, active=? WHERE id=?')
      .run(days_from, days_to || null, daily_rate, description, active ? 1 : 0, req.params.id);
    const rule = await db.prepare('SELECT * FROM pricing_rules WHERE id = ?').get(req.params.id);
    res.json(rule);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/pricing/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.prepare('DELETE FROM pricing_rules WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/staff-list', requireAuth, async (req, res) => {
  try {
    const staff = await db.prepare('SELECT id, name FROM users WHERE carpark_id = ? AND active = 1 ORDER BY name').all(req.session.carparkId || 1);
    res.json(staff);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/admin/me — change own username and/or password (current password required)
router.put('/me', requireAuth, async (req, res) => {
  try {
    const { current_password, new_username, new_password, new_password_confirm } = req.body;
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!current_password || !bcrypt.compareSync(current_password, user.password)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const nuRaw = new_username != null ? String(new_username).trim() : '';
    const pwRaw = new_password != null ? String(new_password) : '';

    if (!nuRaw && !pwRaw) {
      return res.status(400).json({ error: 'Enter a new username and/or new password' });
    }

    let nextUsername = user.username;
    let nextHash = user.password;

    if (nuRaw) {
      if (nuRaw.length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters' });
      const taken = await db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(nuRaw, user.id);
      if (taken) return res.status(400).json({ error: 'Username already taken' });
      nextUsername = nuRaw;
    }

    if (pwRaw) {
      if (pwRaw.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
      if (pwRaw !== String(new_password_confirm || '')) {
        return res.status(400).json({ error: 'New passwords do not match' });
      }
      nextHash = bcrypt.hashSync(pwRaw, 10);
    }

    await db.prepare('UPDATE users SET username = ?, password = ? WHERE id = ?').run(nextUsername, nextHash, user.id);

    const updated = await db.prepare(
      'SELECT id, username, name, email, role, carpark_id FROM users WHERE id = ?'
    ).get(req.session.userId);

    const token = jwt.sign(
      {
        userId: updated.id,
        username: updated.username,
        name: updated.name,
        role: updated.role,
        carparkId: updated.carpark_id,
      },
      JWT_SECRET(),
      { expiresIn: '8h' }
    );
    res.cookie('auth_token', token, COOKIE_OPTS);
    res.json({ success: true, user: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Backfills (run IN-PROCESS, not as standalone scripts) ─────────────────
// IMPORTANT: these must run inside the live server process, not a separate
// `node scripts/...` console session. This app keeps its database fully in
// memory and periodically flushes the whole thing to disk; a separate
// one-off script process has its OWN independent in-memory copy, and
// whichever process saves LAST wins — the live server's next ordinary write
// (anyone editing anything) can silently overwrite and erase a script's
// changes. Running the same logic here, inside the already-running server,
// eliminates that race entirely — there's only ever one copy of the data.

router.post('/backfill/account-allocations', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { allocateAccountPayment } = require('../utils/paymentAllocation');
    const accounts = await db.prepare('SELECT * FROM account_customers').all();
    const results = [];
    let totalAllocated = 0, totalProcessed = 0, totalSkipped = 0;

    for (const account of accounts) {
      const carparkId = account.carpark_id || 1;
      const payments = await db.prepare(`
        SELECT * FROM account_payments WHERE carpark_id = ? AND account_customer_id = ? ORDER BY payment_date ASC, id ASC
      `).all(carparkId, account.id);
      if (payments.length === 0) continue;

      let accountAllocatedCount = 0, accountAllocatedAmount = 0;
      for (const payment of payments) {
        const existingAlloc = await db.prepare(`
          SELECT COUNT(*) as n FROM payment_allocations WHERE carpark_id = ? AND payment_source = 'account' AND payment_id = ?
        `).get(carparkId, payment.id);
        if (existingAlloc.n > 0) { totalSkipped++; continue; }

        const result = await allocateAccountPayment(db, {
          carparkId, accountCustomerId: account.id, paymentId: payment.id, amount: payment.amount,
        });
        totalProcessed++;
        if (result.splits.length > 0) {
          accountAllocatedCount++;
          accountAllocatedAmount += result.splits.reduce((s, x) => s + x.amount_allocated, 0);
        }
      }
      if (accountAllocatedCount > 0) {
        totalAllocated += accountAllocatedAmount;
        results.push({ company_name: account.company_name, payments_allocated: accountAllocatedCount, amount: Math.round(accountAllocatedAmount * 100) / 100 });
      }
    }

    res.json({ success: true, results, totalProcessed, totalSkipped, totalAllocated: Math.round(totalAllocated * 100) / 100 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/backfill/lt-proration-preview', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { inferMonthsForBackfill, isPlausibleDate, buildProratedPayments } = require('../utils/longtermProration');
    const candidates = await db.prepare(`
      SELECT lp.*, lc.name, lc.lt_number, lc.contract_start_date, lc.expiry_date, lc.contract_amount, lc.carpark_id as lt_carpark_id
      FROM longterm_payments lp
      JOIN longterm_customers lc ON lc.id = lp.longterm_customer_id
      WHERE lp.payment_batch_id IS NULL
      ORDER BY lp.longterm_customer_id, lp.payment_date
    `).all();

    // Count how many unprocessed payments each customer has — only trust
    // contract-level dates/total when a customer has exactly one, since
    // that's the only case with no ambiguity about which payment a
    // contract term belongs to.
    const countByCustomer = new Map();
    for (const row of candidates) countByCustomer.set(row.longterm_customer_id, (countByCustomer.get(row.longterm_customer_id) || 0) + 1);

    const preview = [];
    let leftAlone = 0;
    let badDate = 0;
    for (const row of candidates) {
      const isSolePayment = countByCustomer.get(row.longterm_customer_id) === 1;
      const months = inferMonthsForBackfill(
        { contract_start_date: row.contract_start_date, expiry_date: row.expiry_date, contract_amount: row.contract_amount },
        row.amount_ex_gst, isSolePayment
      );
      if (months <= 1) { leftAlone++; continue; }
      const cashReceivedDate = row.cash_received_date || row.payment_date;
      if (!isPlausibleDate(cashReceivedDate)) {
        badDate++;
        preview.push({
          payment_id: row.id, lt_number: row.lt_number, name: row.name,
          original_amount: row.amount_ex_gst, original_date: String(row.payment_date).slice(0, 10),
          months, spread: null, warning: 'SKIPPED — this payment has an invalid/corrupted date in the source data. Fix the date on this payment manually first, then re-run preview.',
        });
        continue;
      }
      const proration = buildProratedPayments({
        totalAmountExGst: row.amount_ex_gst, cashReceivedDate,
        // backfill: always anchor to when cash was actually received, never a possibly-since-updated contract_start_date
        contractStartDate: cashReceivedDate, months,
        transactionReference: row.transaction_reference, baseNotes: row.notes,
      });
      preview.push({
        payment_id: row.id, lt_number: row.lt_number, name: row.name,
        original_amount: row.amount_ex_gst, original_date: String(row.payment_date).slice(0, 10),
        months, spread: proration.rows.map(r => ({ date: r.payment_date, amount: r.amount_ex_gst })),
      });
    }

    res.json({ candidateCount: candidates.length, leftAlone, badDate, toSpread: preview.length - badDate, preview });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/backfill/lt-proration-apply', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { inferMonthsForBackfill, isPlausibleDate, buildProratedPayments } = require('../utils/longtermProration');
    const { logActivity, actorFromReq } = require('../utils/audit');
    const { userId, userName } = actorFromReq(req);

    const candidates = await db.prepare(`
      SELECT lp.*, lc.name, lc.lt_number, lc.contract_start_date, lc.expiry_date, lc.contract_amount, lc.carpark_id as lt_carpark_id
      FROM longterm_payments lp
      JOIN longterm_customers lc ON lc.id = lp.longterm_customer_id
      WHERE lp.payment_batch_id IS NULL
      ORDER BY lp.longterm_customer_id, lp.payment_date
    `).all();

    const countByCustomer = new Map();
    for (const row of candidates) countByCustomer.set(row.longterm_customer_id, (countByCustomer.get(row.longterm_customer_id) || 0) + 1);

    let spread = 0, leftAlone = 0, errors = 0, badDate = 0;
    const errorDetails = [];
    const badDateDetails = [];

    for (const row of candidates) {
      const isSolePayment = countByCustomer.get(row.longterm_customer_id) === 1;
      const months = inferMonthsForBackfill(
        { contract_start_date: row.contract_start_date, expiry_date: row.expiry_date, contract_amount: row.contract_amount },
        row.amount_ex_gst, isSolePayment
      );
      if (months <= 1) { leftAlone++; continue; }

      const cashReceivedDate = row.cash_received_date || row.payment_date;
      if (!isPlausibleDate(cashReceivedDate)) {
        badDate++;
        badDateDetails.push({ payment_id: row.id, lt_number: row.lt_number, date: cashReceivedDate });
        continue;
      }
      const proration = buildProratedPayments({
        totalAmountExGst: row.amount_ex_gst, cashReceivedDate,
        // backfill: always anchor to when cash was actually received, never a possibly-since-updated contract_start_date
        contractStartDate: cashReceivedDate, months,
        transactionReference: row.transaction_reference, baseNotes: row.notes,
      });

      try {
        for (const r of proration.rows) {
          await db.prepare(`
            INSERT INTO longterm_payments
              (carpark_id, longterm_customer_id, payment_date, amount_ex_gst, payment_method, transaction_reference, payment_batch_id, cash_received_date, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(row.lt_carpark_id, row.longterm_customer_id, r.payment_date, r.amount_ex_gst, row.payment_method, row.transaction_reference, r.payment_batch_id, r.cash_received_date, r.notes);
        }
        await db.prepare('DELETE FROM longterm_payments WHERE id = ?').run(row.id);
        await logActivity(db, {
          carparkId: row.lt_carpark_id, tableName: 'longterm_payments', recordId: row.longterm_customer_id, action: 'backfill_proration',
          before: { old_payment_id: row.id, amount_ex_gst: row.amount_ex_gst, payment_date: row.payment_date },
          after: { months, rows: proration.rows },
          notes: `Backfill: spread old payment #${row.id} across ${months} months`, userId, userName,
        });
        spread++;
      } catch (err) {
        errors++;
        errorDetails.push({ payment_id: row.id, lt_number: row.lt_number, error: err.message });
      }
    }

    res.json({ success: true, spread, leftAlone, badDate, badDateDetails, errors, errorDetails });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/backfill/check-account', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { getAccountInvoicesWithOutstanding } = require('../utils/paymentAllocation');
    const query = String(req.query.q || '').trim();
    if (!query) return res.status(400).json({ error: 'Provide ?q=<company name or id>' });

    const isId = /^\d+$/.test(query);
    const accounts = isId
      ? await db.prepare('SELECT * FROM account_customers WHERE id = ?').all(query)
      : await db.prepare('SELECT * FROM account_customers WHERE company_name LIKE ?').all(`%${query}%`);

    const out = [];
    for (const account of accounts) {
      const invoices = await getAccountInvoicesWithOutstanding(db, { carparkId: account.carpark_id || 1, accountCustomerId: account.id });
      const payments = await db.prepare(`SELECT * FROM account_payments WHERE carpark_id = ? AND account_customer_id = ? ORDER BY payment_date ASC`).all(account.carpark_id || 1, account.id);
      const paymentsWithAlloc = [];
      for (const p of payments) {
        const allocRows = await db.prepare(`
          SELECT pa.amount_allocated, i.invoice_number FROM payment_allocations pa JOIN invoices i ON i.id = pa.invoice_id
          WHERE pa.payment_source = 'account' AND pa.payment_id = ?
        `).all(p.id);
        paymentsWithAlloc.push({ ...p, allocations: allocRows });
      }
      out.push({ account: { id: account.id, company_name: account.company_name, carpark_id: account.carpark_id }, invoices, payments: paymentsWithAlloc });
    }
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
