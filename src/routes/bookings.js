const express = require('express');
const { db } = require('../database');
const { requireCustomerAuth } = require('../middleware/customerAuth');
const { calculateShortStayPrice } = require('../utils/pricing');
const { notifyAdminNewBooking, notifyCustomerBookingSubmitted, notifyAdminBookingCancelledByCustomer } = require('../utils/bookingEmails');
const router = express.Router();

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
  };
}

// GET /api/bookings/estimate-price?nights=N — informational only, so the
// customer knows roughly what to expect. Short-stay pricing only (no
// long-term or on-account customer types support self-service booking yet).
// Uses the exact same pricing_rules lookup as staff check-in, so it can
// never drift from what actually gets charged.
router.get('/estimate-price', requireCustomerAuth, async (req, res) => {
  try {
    const result = await calculateShortStayPrice(db, { carparkId: 1, nights: req.query.nights });
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

    const customer = await db.prepare('SELECT * FROM customer_accounts WHERE id = ?').get(customerId);
    if (!customer) return res.status(401).json({ error: 'Not authenticated' });

    const result = await db.prepare(`
      INSERT INTO bookings
        (carpark_id, customer_account_id, first_name, last_name, phone, email,
         rego, vehicle_make, vehicle_model, vehicle_color, date_in, time_in, date_out, time_out, notes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      carparkId, customerId, customer.first_name, customer.last_name, customer.phone, customer.email,
      rego, vehicleMake || null, vehicleModel || null, vehicleColor || null, dateIn, timeIn, dateOut, timeOut, notes || null
    );

    const booking = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);

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
      SELECT * FROM bookings WHERE customer_account_id = ? ORDER BY date_in DESC, created_at DESC
    `).all(req.customerSession.customerId);
    res.json(bookings.map(publicBooking));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
