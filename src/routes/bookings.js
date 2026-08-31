const express = require('express');
const { db } = require('../database');
const { requireCustomerAuth } = require('../middleware/customerAuth');
const { calculateShortStayPrice } = require('../utils/pricing');
const { getAccountInvoicesWithOutstanding } = require('../utils/paymentAllocation');
const { notifyAdminNewBooking, notifyCustomerBookingSubmitted, notifyAdminBookingCancelledByCustomer } = require('../utils/bookingEmails');
const router = express.Router();

// A long-term request needs to actually be long-term — otherwise anyone
// could tick the toggle hoping for a better (individually quoted) rate on
// what's really a short stay. Staff can ask for this to change; it's a
// single constant.
const MIN_LONGTERM_DAYS = 28;

// ─── Account-number lookup rate limiting ────────────────────────────────────
// Same shape as the login/register limiters in src/routes/customerAuth.js.
// This endpoint reveals a real business's outstanding balance, so it
// shouldn't be brute-forceable against many candidate account numbers.
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const lookupAttempts = new Map(); // key -> { count, lockedUntil }

function attemptKey(req, accountNumber) {
  return `${req.ip || 'unknown'}:${String(accountNumber || '').trim().toUpperCase()}`;
}
function isLocked(key) {
  const rec = lookupAttempts.get(key);
  if (!rec || !rec.lockedUntil) return false;
  if (Date.now() > rec.lockedUntil) { lookupAttempts.delete(key); return false; }
  return true;
}
function recordFailure(key) {
  const rec = lookupAttempts.get(key) || { count: 0, lockedUntil: null };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) rec.lockedUntil = Date.now() + WINDOW_MS;
  lookupAttempts.set(key, rec);
}

/** Resolves a staff-issued account number to a real, active account_customers row (or null). */
async function resolveAccountByNumber(carparkId, accountNumber) {
  const code = String(accountNumber || '').trim().toUpperCase();
  if (!code) return null;
  return db.prepare(`
    SELECT * FROM account_customers WHERE carpark_id = ? AND active = 1 AND UPPER(account_number) = ?
  `).get(carparkId, code);
}

function isValidYmd(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

function isValidHm(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
}

// Same 24-hour-block rule the staff check-in form uses (calcNights24h in
// public/js/common.js) — kept in sync by hand since this route has no
// browser DOM to share that function with. A stay is billed in whole 24h
// blocks from drop-off to pick-up, rounded up, minimum 1.
function calcNights24h(dateIn, timeIn, dateOut, timeOut) {
  const t1 = Date.parse(`${dateIn}T${timeIn}:00Z`);
  const t2 = Date.parse(`${dateOut}T${timeOut}:00Z`);
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return 1;
  const diffMs = t2 - t1;
  const dayMs = 24 * 60 * 60 * 1000;
  if (diffMs <= dayMs) return 1;
  return Math.max(1, Math.ceil(diffMs / dayMs));
}

function daysBetweenYmd(fromYmd, toYmd) {
  const a = new Date(`${fromYmd}T00:00:00Z`);
  const b = new Date(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function publicBooking(b) {
  return {
    id: b.id,
    firstName: b.first_name,
    lastName: b.last_name,
    phone: b.phone,
    email: b.email,
    rego: b.rego,
    vehicleMake: b.vehicle_make,
    vehicleModel: b.vehicle_model,
    vehicleColor: b.vehicle_color,
    dateIn: b.date_in,
    timeIn: b.time_in,
    dateOut: b.date_out,
    timeOut: b.time_out,
    status: b.status,
    notes: b.notes,
    createdAt: b.created_at,
    isLongTerm: !!b.is_long_term,
    accountCompanyName: b.account_company_name || null,
  };
}

// GET /api/bookings/account-lookup?accountNumber=X — used by the booking
// form to show a real company name + outstanding balance before the
// customer submits, so "on account" means something concrete rather than a
// free-text claim. Never invents/reveals anything for a number that doesn't
// match a real, active account.
router.get('/account-lookup', requireCustomerAuth, async (req, res) => {
  try {
    const carparkId = 1;
    const accountNumber = String(req.query.accountNumber || '').trim();
    if (!accountNumber) return res.status(400).json({ error: 'accountNumber is required' });

    const key = attemptKey(req, accountNumber);
    if (isLocked(key)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });

    const account = await resolveAccountByNumber(carparkId, accountNumber);
    if (!account) {
      recordFailure(key);
      return res.status(404).json({ error: 'Account number not recognized — check the number or contact us' });
    }

    const invoices = await getAccountInvoicesWithOutstanding(db, { carparkId, accountCustomerId: account.id });
    const outstandingBalance = Math.round(invoices.reduce((s, i) => s + i.outstanding_amount, 0) * 100) / 100;

    res.json({ companyName: account.company_name, outstandingBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bookings/estimate-price?nights=N&accountNumber=&isLongTerm=
// Informational only, so the customer knows roughly what to expect. Uses
// the exact same pricing_rules lookup as staff check-in, so it can never
// drift from what actually gets charged. Long-term rates are individually
// quoted per contract (no published rate card exists), so this returns
// { longTerm: true } instead of a number when isLongTerm is set — never a
// made-up figure. accountNumber is re-resolved server-side (never trusts a
// client-supplied internal id) so an on-account customer sees their real
// contracted rate.
router.get('/estimate-price', requireCustomerAuth, async (req, res) => {
  try {
    if (String(req.query.isLongTerm) === 'true') {
      return res.json({ longTerm: true });
    }
    const carparkId = 1;
    let accountCustomerId = null;
    if (req.query.accountNumber) {
      const account = await resolveAccountByNumber(carparkId, req.query.accountNumber);
      if (account) accountCustomerId = account.id;
    }
    const result = await calculateShortStayPrice(db, { carparkId, nights: req.query.nights, accountCustomerId });
    res.json({ nights: result.nights, dailyRate: result.dailyRate, total: result.total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bookings — customer submits a new booking request.
// No availability/capacity checking — accepted as submitted, staff allocate manually.
router.post('/', requireCustomerAuth, async (req, res) => {
  try {
    const carparkId = 1;
    const customerId = req.customerSession.customerId;

    const rego = String(req.body?.rego || '').trim().toUpperCase();
    const vehicleMake = String(req.body?.vehicleMake || '').trim();
    const vehicleModel = String(req.body?.vehicleModel || '').trim();
    const vehicleColor = String(req.body?.vehicleColor || '').trim();
    const dateIn = String(req.body?.dateIn || '').trim();
    const timeIn = String(req.body?.timeIn || '').trim();
    const dateOut = String(req.body?.dateOut || '').trim();
    const timeOut = String(req.body?.timeOut || '').trim();
    const notes = String(req.body?.notes || '').trim();
    const isLongTerm = !!req.body?.isLongTerm;
    const wantsAccount = !!req.body?.wantsAccount;

    if (!rego) return res.status(400).json({ error: 'Vehicle registration is required' });
    if (!isValidYmd(dateIn) || !isValidYmd(dateOut)) {
      return res.status(400).json({ error: 'Drop-off and pick-up dates are required (YYYY-MM-DD)' });
    }
    if (!isValidHm(timeIn) || !isValidHm(timeOut)) {
      return res.status(400).json({ error: 'Drop-off and pick-up times are required (HH:MM)' });
    }
    if (dateOut < dateIn) return res.status(400).json({ error: 'Pick-up date cannot be before the drop-off date' });
    if (dateOut === dateIn && timeOut <= timeIn) {
      return res.status(400).json({ error: 'Pick-up time must be after drop-off time on the same day' });
    }
    if (isLongTerm && daysBetweenYmd(dateIn, dateOut) < MIN_LONGTERM_DAYS) {
      return res.status(400).json({ error: `Long-term bookings need to be at least ${MIN_LONGTERM_DAYS} days — for shorter stays, use standard booking.` });
    }

    let accountCustomerId = null;
    let accountCompanyName = null;
    if (wantsAccount) {
      const account = await resolveAccountByNumber(carparkId, req.body?.accountNumber);
      if (!account) return res.status(400).json({ error: 'Account number not recognized — check the number or contact us' });
      accountCustomerId = account.id;
      accountCompanyName = account.company_name;
    }

    const customer = await db.prepare('SELECT * FROM customer_accounts WHERE id = ?').get(customerId);
    if (!customer) return res.status(401).json({ error: 'Not authenticated' });

    const result = await db.prepare(`
      INSERT INTO bookings
        (carpark_id, customer_account_id, first_name, last_name, phone, email,
         rego, vehicle_make, vehicle_model, vehicle_color, date_in, time_in, date_out, time_out, notes,
         is_long_term, account_customer_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      carparkId, customerId, customer.first_name, customer.last_name, customer.phone, customer.email,
      rego, vehicleMake || null, vehicleModel || null, vehicleColor || null, dateIn, timeIn, dateOut, timeOut, notes || null,
      isLongTerm ? 1 : 0, accountCustomerId
    );

    const booking = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);
    booking.account_company_name = accountCompanyName; // decorate in-memory only, for the admin notification banner

    await Promise.all([
      notifyCustomerBookingSubmitted(booking),
      notifyAdminNewBooking(booking),
    ]);

    res.status(201).json({ success: true, booking: publicBooking(booking) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bookings/:id/cancel — customer cancels their own booking, only
// while it's still pending (once staff have allocated it to a real spot,
// cancelling is handled through the normal invoice void flow instead).
router.post('/:id/cancel', requireCustomerAuth, async (req, res) => {
  try {
    const booking = await db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_account_id = ?')
      .get(req.params.id, req.customerSession.customerId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== 'pending') {
      return res.status(400).json({ error: `This booking is already ${booking.status} and can't be cancelled here.` });
    }

    await db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).run(booking.id);
    await notifyAdminBookingCancelledByCustomer(booking);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bookings/mine — the logged-in customer's own booking history.
router.get('/mine', requireCustomerAuth, async (req, res) => {
  try {
    const bookings = await db.prepare(`
      SELECT b.*, ac.company_name as account_company_name
      FROM bookings b
      LEFT JOIN account_customers ac ON ac.id = b.account_customer_id
      WHERE b.customer_account_id = ? ORDER BY b.date_in DESC, b.created_at DESC
    `).all(req.customerSession.customerId);
    res.json(bookings.map(publicBooking));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
