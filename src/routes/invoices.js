const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { releaseKey, syncKeyBoxForPickedUp, checkKeyConflict } = require('../utils/keyBoxSync');
const { businessDateYmd } = require('../utils/businessDate');
const { logActivity, actorFromReq } = require('../utils/audit');
const { checkAndCreateEarlyReturnCredit, findAvailableCredit, applyCreditToInvoice, releaseCreditForInvoice } = require('../utils/customerCredit');
const { deallocateInvoice } = require('../utils/paymentAllocation');
const { streamInvoicePdf } = require('../utils/invoicePdf');
const router = express.Router();

// GET /api/invoices/credits/lookup?phone=&first_name=&last_name=
// Called from the booking form when a phone/name is entered, so staff see
// "this customer has $X credit" before they finish the new booking.
router.get('/credits/lookup', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { phone, first_name, last_name } = req.query;
    if (!phone && !(first_name && last_name)) {
      return res.json({ credits: [], totalAvailable: 0 });
    }
    const result = await findAvailableCredit(db, { carparkId, phone, firstName: first_name, lastName: last_name });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/invoices/:id/apply-credit  { amount, phone, first_name, last_name }
// Applies up to `amount` of the customer's available credit to this invoice.
router.post('/:id/apply-credit', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { id } = req.params;
    const { amount, phone, first_name, last_name } = req.body || {};
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be > 0' });
    const invoice = await db.prepare('SELECT id FROM invoices WHERE id = ? AND carpark_id = ?').get(id, carparkId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const { userId, userName } = actorFromReq(req);
    const result = await applyCreditToInvoice(db, {
      carparkId, invoiceId: id, amount: amt, phone, firstName: first_name, lastName: last_name, userId, userName,
    });
    if (result.applied <= 0) {
      return res.status(400).json({ error: 'No credit could be applied — invoice may already be fully covered, or no matching credit was found' });
    }
    const updated = await db.prepare('SELECT credit_applied, total_price FROM invoices WHERE id = ?').get(id);
    res.json({ ...result, credit_applied: updated.credit_applied, total_price: updated.total_price });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function normalizeTimeString(raw) {
  let s = String(raw || '').trim().replace(/\u202f/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  s = s.replace(/^(\d{1,2}):(\d{2}):\d{2}/, '$1:$2');
  s = s.replace(/([ap])\.?\s*m\.?$/i, '$1m');
  return s.trim();
}

function parseClockToHm(input) {
  const s = normalizeTimeString(input);
  const m = s.match(/^(\d{1,2}):(\d{2})(?:\s*([ap]m))?$/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = (m[3] || '').toLowerCase();
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (mm < 0 || mm > 59) return null;
  if (ap) {
    if (hh < 1 || hh > 12) return null;
    if (ap === 'am') hh = (hh === 12) ? 0 : hh;
    if (ap === 'pm') hh = (hh === 12) ? 12 : (hh + 12);
  } else {
    if (hh < 0 || hh > 23) return null;
  }
  return { hh, mm };
}

function deriveStayNights24h(dateIn, timeIn, returnDate, returnTime, fallback = 0) {
  const f = parseInt(fallback, 10);
  if (!dateIn || !returnDate) return Number.isFinite(f) ? f : 0;
  const [y1, m1, d1] = String(dateIn).slice(0, 10).split('-').map(Number);
  const [y2, m2, d2] = String(returnDate).slice(0, 10).split('-').map(Number);
  if (![y1, m1, d1, y2, m2, d2].every(Number.isFinite)) return Number.isFinite(f) ? f : 0;

  const tIn = parseClockToHm(timeIn);
  const tOut = parseClockToHm(returnTime);
  if (tIn && tOut) {
    const t1 = Date.UTC(y1, m1 - 1, d1, tIn.hh, tIn.mm);
    const t2 = Date.UTC(y2, m2 - 1, d2, tOut.hh, tOut.mm);
    const diffMs = t2 - t1;
    if (diffMs <= 0) return 1;
    const dayMs = 24 * 60 * 60 * 1000;
    if (diffMs <= dayMs) return 1;
    return Math.max(1, Math.ceil(diffMs / dayMs));
  }

  // Fallback: date-based (previous behavior)
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  const diffDays = Math.round((t2 - t1) / (1000 * 60 * 60 * 24));
  return diffDays <= 0 ? 1 : diffDays;
}

function isPaidLine(statusRaw, amountRaw) {
  const status = String(statusRaw || '').trim();
  const amount = parseFloat(amountRaw || 0) || 0;
  return amount > 0 && status && status !== 'To Pay';
}

function normalizePaymentDateYmd(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

/** Resolves payment_date_1/2 from the request body (staff-entered banked date) with fallbacks. */
function resolvePaymentDates(body, existing, today) {
  const {
    paid_status, payment_amount, paid_status_2, payment_amount_2,
    payment_date_1: body1, payment_date_2: body2
  } = body;
  let pd1 = null;
  if (isPaidLine(paid_status, payment_amount)) {
    const fromClient = normalizePaymentDateYmd(body1);
    const prior = existing && normalizePaymentDateYmd(existing.payment_date_1);
    pd1 = fromClient || prior || today;
  }
  let pd2 = null;
  if (isPaidLine(paid_status_2, payment_amount_2)) {
    const fromClient = normalizePaymentDateYmd(body2);
    const prior = existing && normalizePaymentDateYmd(existing.payment_date_2);
    pd2 = fromClient || prior || today;
  }
  return { pd1, pd2 };
}

// GET /api/invoices/calculate-price  – MUST be before /:id
router.get('/calculate-price', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { nights, account_customer_id } = req.query;
    const n = parseInt(nights) || 1;
    const accountRateCard = {
      1: 18.00,
      2: 16.50,
      3: 16.00,
      4: 15.75,
      5: 15.60,
      6: 15.50,
      7: 15.43,
      8: 15.00,
      9: 14.67,
    };

    if (account_customer_id && accountRateCard[n]) {
      const dailyRate = accountRateCard[n];
      const total = Math.round((dailyRate * n) * 100) / 100;
      return res.json({
        nights: n,
        dailyRate,
        total,
        discountPercent: 0,
        pricing_mode: 'account_rate_card',
      });
    }

    let discountPercent = 0;
    if (account_customer_id) {
      const acct = await db.prepare('SELECT discount_percent FROM account_customers WHERE id = ?').get(account_customer_id);
      if (acct) discountPercent = acct.discount_percent || 0;
    }
    const rule = await db.prepare(`
      SELECT * FROM pricing_rules
      WHERE carpark_id = ? AND customer_type = 'short' AND active = 1
      AND days_from <= ? AND (days_to IS NULL OR days_to >= ?)
      ORDER BY days_from DESC LIMIT 1
    `).get(carparkId, n, n);
    const dailyRate = rule ? rule.daily_rate : 10.00;
    let total = dailyRate * n;
    if (discountPercent > 0) total = total * (1 - discountPercent / 100);
    res.json({ nights: n, dailyRate, total: Math.round(total * 100) / 100, discountPercent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/invoices/lookup-rego
router.get('/lookup-rego', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { rego, email: emailQuery } = req.query;
    if (!rego) return res.json({ invoice: null, longterm: null, accountCustomer: null });
    const r = rego.trim();
    const invoice = await db.prepare(`
      SELECT i.*, c.alert_message as customer_alert_stored,
             c.first_name AS _cust_first_name,
             c.last_name AS _cust_last_name,
             c.phone AS _cust_phone,
             c.email AS _cust_email
      FROM invoices i
      LEFT JOIN customers c ON i.customer_id = c.id
      WHERE i.carpark_id = ? AND UPPER(i.rego) = UPPER(?) AND i.void = 0
      ORDER BY i.created_at DESC LIMIT 1
    `).get(carparkId, r);

    // Prefer current customer master record when invoice snapshot is missing fields.
    if (invoice) {
      const pick = (invVal, custVal) => {
        const iv = invVal != null ? String(invVal).trim() : '';
        const cv = custVal != null ? String(custVal).trim() : '';
        return iv || cv || '';
      };
      invoice.first_name = pick(invoice.first_name, invoice._cust_first_name);
      invoice.last_name = pick(invoice.last_name, invoice._cust_last_name);
      invoice.phone = pick(invoice.phone, invoice._cust_phone);
      invoice.email = pick(invoice.email, invoice._cust_email);
      delete invoice._cust_first_name;
      delete invoice._cust_last_name;
      delete invoice._cust_phone;
      delete invoice._cust_email;
    }

    const longterm = await db.prepare(`
      SELECT * FROM longterm_customers
      WHERE carpark_id = ? AND active = 1
        AND (UPPER(TRIM(COALESCE(rego_1,''))) = UPPER(?) OR UPPER(TRIM(COALESCE(rego_2,''))) = UPPER(?))
      LIMIT 1
    `).get(carparkId, r, r);

    let accountCustomer = null;
    accountCustomer = await db.prepare(`
      SELECT * FROM account_customers
      WHERE carpark_id = ? AND active = 1
        AND (UPPER(TRIM(COALESCE(rego_1,''))) = UPPER(?) OR UPPER(TRIM(COALESCE(rego_2,''))) = UPPER(?))
      LIMIT 1
    `).get(carparkId, r, r);

    const email = (invoice && String(invoice.email || '').trim())
      ? String(invoice.email).trim()
      : (emailQuery ? String(emailQuery).trim() : '');
    if (!accountCustomer && email) {
      accountCustomer = await db.prepare(`
        SELECT * FROM account_customers
        WHERE carpark_id = ? AND active = 1
          AND (LOWER(TRIM(COALESCE(email,''))) = LOWER(?)
               OR LOWER(TRIM(COALESCE(billing_email,''))) = LOWER(?))
        LIMIT 1
      `).get(carparkId, email, email);
    }

    res.json({
      invoice: invoice || null,
      longterm: longterm || null,
      accountCustomer: accountCustomer || null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/invoices/next-number
router.get('/next-number', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const result = await db.prepare('SELECT MAX(invoice_number) as max FROM invoices WHERE carpark_id = ?').get(carparkId);
    res.json({ invoiceNumber: (result.max || 18999) + 1 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/invoices
router.get('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { search, date, status, void: showVoid, customer_id, limit, offset } = req.query;
    let query = `
      SELECT i.*, u.name as staff_name, ac.company_name as account_name
      FROM invoices i
      LEFT JOIN users u ON i.staff_id = u.id
      LEFT JOIN account_customers ac ON i.account_customer_id = ac.id
      WHERE i.carpark_id = ?
    `;
    const params = [carparkId];
    if (showVoid !== 'true') query += ' AND i.void = 0';
    if (date)        { query += ' AND DATE(i.date_in) = ?'; params.push(date); }
    if (status)      { query += ' AND i.paid_status = ?';   params.push(status); }
    if (customer_id) { query += ' AND i.customer_id = ?';   params.push(customer_id); }
    if (search) {
      query += ` AND (i.invoice_number LIKE ? OR i.last_name LIKE ? OR i.first_name LIKE ? OR i.rego LIKE ? OR i.phone LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }
    const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 200));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    query += ' ORDER BY i.created_at DESC LIMIT ? OFFSET ?';
    params.push(lim, off);
    const invoices = await db.prepare(query).all(...params);
    res.json(invoices);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/invoices/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const carparkId = req.session.carparkId || 1;
    const invoice = await db.prepare(`
      SELECT i.*, u.name as staff_name, ac.company_name as account_name, ac.billing_email as account_billing_email
      FROM invoices i
      LEFT JOIN users u ON i.staff_id = u.id
      LEFT JOIN account_customers ac ON i.account_customer_id = ac.id
      WHERE i.id = ? AND i.carpark_id = ?
    `).get(id, carparkId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    res.json(invoice);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/invoices
router.post('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const {
      invoice_number, customer_id, account_customer_id, key_number, no_key,
      rego, first_name, last_name, phone, email,
      date_in, time_in, return_date, return_time, stay_nights,
      flight_info, flight_type, total_price, credit_applied, discount_percent,
      paid_status, payment_amount, payment_method, paid_status_2, payment_amount_2, payment_method_2,
      payment_date_1, payment_date_2,
      do_not_move, picked_up, staff_id, notes, customer_alert
    } = req.body;

    const existing = await db.prepare('SELECT id FROM invoices WHERE invoice_number = ? AND carpark_id = ?').get(invoice_number, carparkId);
    if (existing) return res.status(400).json({ error: 'Invoice number already exists' });

    const finalPickedUp = picked_up || 'Car In Yard';

    // A key can't physically be in two cars at once — block the save instead
    // of silently letting this booking steal a key that's already out.
    if (!no_key && key_number && finalPickedUp === 'Car In Yard') {
      const conflict = await checkKeyConflict(db, carparkId, key_number);
      if (conflict) {
        return res.status(409).json({ error: `Key ${key_number} is already in use by ${conflict.description}. Pick a different key or release that one first.` });
      }
    }

    const computedStayNights = deriveStayNights24h(date_in, time_in, return_date, return_time, stay_nights);
    const today = businessDateYmd();
    const { pd1: paymentDate1, pd2: paymentDate2 } = resolvePaymentDates(
      { ...req.body, payment_date_1, payment_date_2 },
      null,
      today
    );

    const result = await db.prepare(`
      INSERT INTO invoices (
        invoice_number, carpark_id, customer_id, account_customer_id, key_number, no_key,
        rego, first_name, last_name, phone, email,
        date_in, time_in, return_date, return_time, stay_nights,
        flight_info, flight_type, total_price, credit_applied, discount_percent,
        paid_status, payment_amount, payment_method, paid_status_2, payment_amount_2, payment_method_2,
        payment_date_1, payment_date_2,
        do_not_move, picked_up, staff_id, notes, customer_alert
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      invoice_number, carparkId, customer_id || null, account_customer_id || null, key_number || null, no_key ? 1 : 0,
      rego, first_name, last_name, phone, email,
      date_in, time_in, return_date, return_time, computedStayNights,
      flight_info, flight_type || 'Standard - On Flight', total_price || 0, credit_applied || 0, discount_percent || 0,
      paid_status || 'To Pay', payment_amount || 0, payment_method,
      paid_status_2 || null, payment_amount_2 || 0, payment_method_2 || null,
      paymentDate1, paymentDate2,
      do_not_move ? 1 : 0, finalPickedUp, staff_id || req.session.userId, notes, customer_alert
    );

    await syncKeyBoxForPickedUp(db, carparkId, result.lastInsertRowid, {
      key_number,
      no_key: no_key ? 1 : 0
    }, finalPickedUp);

    const newInvoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(newInvoice);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/invoices/:id
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const carparkId = req.session.carparkId || 1;
    const {
      key_number, no_key, rego, first_name, last_name, phone, email,
      date_in, time_in, return_date, return_time, stay_nights,
      flight_info, flight_type, total_price, credit_applied, discount_percent,
      paid_status, payment_amount, payment_method, paid_status_2, payment_amount_2, payment_method_2,
      payment_date_1, payment_date_2,
      do_not_move, picked_up, staff_id, notes, customer_alert, account_customer_id
    } = req.body;

    const existing = await db.prepare('SELECT * FROM invoices WHERE id = ? AND carpark_id = ?').get(id, carparkId);
    if (!existing) return res.status(404).json({ error: 'Invoice not found' });

    // Release old key if changed
    if (existing.key_number && existing.key_number != key_number) {
      await releaseKey(db, carparkId, existing.key_number);
    }

    const finalPickedUp = picked_up || 'Car In Yard';

    // A key can't physically be in two cars at once — block the save instead
    // of silently letting this booking steal a key that's already out.
    // excludeInvoiceId covers the case where this invoice already legitimately
    // holds the key (re-saving without changing it).
    if (!no_key && key_number && finalPickedUp === 'Car In Yard') {
      const conflict = await checkKeyConflict(db, carparkId, key_number, { excludeInvoiceId: id });
      if (conflict) {
        return res.status(409).json({ error: `Key ${key_number} is already in use by ${conflict.description}. Pick a different key or release that one first.` });
      }
    }

    const computedStayNights = deriveStayNights24h(date_in, time_in, return_date, return_time, stay_nights);
    const today = businessDateYmd();
    const { pd1: nextPaymentDate1, pd2: nextPaymentDate2 } = resolvePaymentDates(
      { ...req.body, payment_date_1, payment_date_2 },
      existing,
      today
    );

    await db.prepare(`
      UPDATE invoices SET
        key_number = ?, no_key = ?, rego = ?, first_name = ?, last_name = ?,
        phone = ?, email = ?, date_in = ?, time_in = ?, return_date = ?, return_time = ?,
        stay_nights = ?, flight_info = ?, flight_type = ?, total_price = ?,
        credit_applied = ?, discount_percent = ?, paid_status = ?, payment_amount = ?,
        payment_method = ?, paid_status_2 = ?, payment_amount_2 = ?, payment_method_2 = ?,
        payment_date_1 = ?, payment_date_2 = ?,
        do_not_move = ?, picked_up = ?, staff_id = ?, notes = ?, customer_alert = ?,
        account_customer_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND carpark_id = ?
    `).run(
      key_number || null, no_key ? 1 : 0, rego, first_name, last_name,
      phone, email, date_in, time_in, return_date, return_time,
      computedStayNights, flight_info, flight_type || 'Standard - On Flight', total_price || 0,
      credit_applied || 0, discount_percent || 0, paid_status || 'To Pay', payment_amount || 0,
      payment_method, paid_status_2 || null, payment_amount_2 || 0, payment_method_2 || null,
      nextPaymentDate1, nextPaymentDate2,
      do_not_move ? 1 : 0, finalPickedUp, staff_id || req.session.userId, notes, customer_alert,
      account_customer_id || null, id, carparkId
    );

    await syncKeyBoxForPickedUp(db, carparkId, id, {
      key_number,
      no_key: no_key ? 1 : 0
    }, finalPickedUp);

    // Same early-return credit check as the Returns page — covers staff
    // marking a booking picked up directly from the invoice edit screen
    // instead of via Returns. Only fires on the transition INTO a picked-up
    // state (not on every save of an already-picked-up booking).
    let earlyReturnCredit = null;
    const wasInYard = !existing.picked_up || existing.picked_up === 'Car In Yard';
    const nowDeparted = finalPickedUp !== 'Car In Yard' && finalPickedUp !== 'Voided';
    if (wasInYard && nowDeparted) {
      const { userId, userName } = actorFromReq(req);
      earlyReturnCredit = await checkAndCreateEarlyReturnCredit(db, {
        carparkId, invoiceId: Number(id), actualReturnDate: businessDateYmd(), userId, userName,
      });
    }

    const updated = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);

    // Only log when a money-relevant field actually changed, to keep the
    // audit trail readable — routine detail edits (phone number, notes,
    // flight info) don't need a log entry, but payment status/amount does.
    const moneyFields = ['paid_status', 'payment_amount', 'payment_method', 'paid_status_2', 'payment_amount_2', 'payment_method_2', 'total_price', 'discount_percent', 'credit_applied'];
    const changed = moneyFields.some(f => String(existing[f] ?? '') !== String(updated[f] ?? ''));
    if (changed) {
      const { userId, userName } = actorFromReq(req);
      await logActivity(db, {
        carparkId, tableName: 'invoices', recordId: id, action: 'update_payment',
        before: existing, after: updated, userId, userName,
      });
    }

    res.json({ ...updated, earlyReturnCredit });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/invoices/:id  – permanently removes the booking
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const carparkId = req.session.carparkId || 1;
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ? AND carpark_id = ?').get(id, carparkId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Release key so it becomes available again
    if (invoice.key_number && !invoice.no_key) {
      await releaseKey(db, carparkId, invoice.key_number);
    }
    // Must free allocations BEFORE deleting the invoice row — afterward
    // there'd be nothing left to join against to find them.
    const freedAllocations = await deallocateInvoice(db, { carparkId, invoiceId: id });
    await db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
    const { userId, userName } = actorFromReq(req);
    if (invoice.credit_applied > 0) {
      await releaseCreditForInvoice(db, { carparkId, invoiceId: id, userId, userName });
    }
    await logActivity(db, { carparkId, tableName: 'invoices', recordId: id, action: 'delete', before: invoice, after: null, userId, userName });
    if (freedAllocations.length > 0) {
      await logActivity(db, {
        carparkId, tableName: 'payment_allocations', recordId: id, action: 'freed_on_delete',
        before: freedAllocations, after: null,
        notes: `Freed ${freedAllocations.length} allocation(s) totalling $${freedAllocations.reduce((s, a) => s + a.amount_allocated, 0).toFixed(2)} when invoice #${invoice.invoice_number} was deleted`,
        userId, userName,
      });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/invoices/:id/void
router.post('/:id/void', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const carparkId = req.session.carparkId || 1;
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ? AND carpark_id = ?').get(id, carparkId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    await db.prepare("UPDATE invoices SET void = 1, picked_up = 'Voided', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    if (invoice.key_number) {
      await releaseKey(db, carparkId, invoice.key_number);
    }
    // Free up any payment that was allocated to this invoice — it's no
    // longer owed, so that money becomes available credit again instead of
    // silently vanishing from every "paid" total.
    const freedAllocations = await deallocateInvoice(db, { carparkId, invoiceId: id });
    const { userId, userName } = actorFromReq(req);
    if (invoice.credit_applied > 0) {
      await releaseCreditForInvoice(db, { carparkId, invoiceId: id, userId, userName });
    }
    await logActivity(db, { carparkId, tableName: 'invoices', recordId: id, action: 'void', before: invoice, after: { ...invoice, void: 1, picked_up: 'Voided' }, userId, userName });
    if (freedAllocations.length > 0) {
      await logActivity(db, {
        carparkId, tableName: 'payment_allocations', recordId: id, action: 'freed_on_void',
        before: freedAllocations, after: null,
        notes: `Freed ${freedAllocations.length} allocation(s) totalling $${freedAllocations.reduce((s, a) => s + a.amount_allocated, 0).toFixed(2)} when invoice #${invoice.invoice_number} was voided`,
        userId, userName,
      });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/invoices/:id/refund
router.post('/:id/refund', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { refund_amount, refund_reason } = req.body;
    const carparkId = req.session.carparkId || 1;
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ? AND carpark_id = ?').get(id, carparkId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    await db.prepare("UPDATE invoices SET refund_amount = ?, refund_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(refund_amount, refund_reason, id);
    const { userId, userName } = actorFromReq(req);
    await logActivity(db, {
      carparkId, tableName: 'invoices', recordId: id, action: 'refund',
      before: invoice, after: { ...invoice, refund_amount, refund_reason },
      notes: refund_reason, userId, userName,
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/invoices/:id/pdf
router.get('/:id/pdf', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const carparkId = req.session.carparkId || 1;
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ? AND carpark_id = ?').get(id, carparkId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    const carpark = await db.prepare('SELECT * FROM carparks WHERE id = ?').get(carparkId);
    streamInvoicePdf(res, invoice, carpark);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
