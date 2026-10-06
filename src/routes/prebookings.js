const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { businessDateYmd, addCalendarDaysYmd } = require('../utils/businessDate');
const { logActivity, actorFromReq } = require('../utils/audit');
const {
  notifyCustomerBookingConfirmed,
  notifyCustomerBookingUpdated,
  notifyCustomerBookingAllocated,
  notifyCustomerBookingCancelled,
  notifyCustomerNoShow,
} = require('../utils/bookingEmails');
const router = express.Router();

// Lifecycle: pending (customer asked) -> confirmed (staff accepted, customer
// emailed) -> allocated (checked in, invoice created). Cancelled / no_show /
// auto_cancelled are the exits. "Active" = still waiting for the customer.
const ACTIVE_STATUSES = ['pending', 'confirmed'];

function isValidYmd(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}
function isValidHm(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
}

function publicPrebooking(b, todayYmd) {
  const dateIn = String(b.date_in).slice(0, 10);
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
    invoiceId: b.invoice_id,
    createdAt: b.created_at,
    confirmedAt: b.confirmed_at || null,
    overdue: dateIn < todayYmd,
    arrivingToday: dateIn === todayYmd,
    isLongTerm: !!b.is_long_term,
    accountCustomerId: b.account_customer_id || null,
    accountCompanyName: b.account_company_name || null,
  };
}

const ACTIVE_SQL = ACTIVE_STATUSES.map(() => '?').join(',');

// GET /api/prebookings — bookings staff still need to deal with (pending or
// confirmed), oldest date_in first. Nothing is filtered out by date, since a
// booking whose date_in has already passed still needs handling, not hiding.
router.get('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const today = businessDateYmd();
    const bookings = await db.prepare(`
      SELECT b.*, ac.company_name as account_company_name
      FROM bookings b
      LEFT JOIN account_customers ac ON ac.id = b.account_customer_id
      WHERE b.carpark_id = ? AND b.status IN (${ACTIVE_SQL})
      ORDER BY b.date_in ASC, b.time_in ASC, b.created_at ASC
    `).all(carparkId, ...ACTIVE_STATUSES);
    res.json(bookings.map((b) => publicPrebooking(b, today)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prebookings/summary — drives the nav badge, the "arriving today"
// panel on the menu, and the popup. Must be registered before '/:id'.
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const today = businessDateYmd();
    const tomorrow = addCalendarDaysYmd(today, 1);
    const rows = await db.prepare(`
      SELECT * FROM bookings
      WHERE carpark_id = ? AND status IN (${ACTIVE_SQL})
      ORDER BY date_in ASC, time_in ASC
    `).all(carparkId, ...ACTIVE_STATUSES);

    const dateOf = (b) => String(b.date_in).slice(0, 10);
    const awaitingAccept = rows.filter((b) => b.status === 'pending');
    const arrivingToday = rows.filter((b) => dateOf(b) === today);
    const arrivingTomorrow = rows.filter((b) => dateOf(b) === tomorrow);
    const overdue = rows.filter((b) => dateOf(b) < today);
    const needsAttention = new Set([...awaitingAccept, ...arrivingToday, ...overdue].map((b) => b.id)).size;

    const brief = (b) => ({
      id: b.id,
      name: `${b.first_name || ''} ${b.last_name || ''}`.trim(),
      rego: b.rego,
      timeIn: b.time_in,
      dateIn: dateOf(b),
      status: b.status,
    });

    res.json({
      businessDate: today,
      total: rows.length,
      awaitingAccept: awaitingAccept.length,
      arrivingToday: arrivingToday.length,
      arrivingTomorrow: arrivingTomorrow.length,
      overdue: overdue.length,
      needsAttention,
      todayList: arrivingToday.map(brief),
      overdueList: overdue.map(brief),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prebookings/:id — single booking detail, used by invoice.html to
// prefill the check-in form when staff click "Allocate".
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const booking = await db.prepare(`
      SELECT b.*, ac.company_name as account_company_name
      FROM bookings b
      LEFT JOIN account_customers ac ON ac.id = b.account_customer_id
      WHERE b.id = ? AND b.carpark_id = ?
    `).get(req.params.id, carparkId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    res.json(publicPrebooking(booking, businessDateYmd()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prebookings/:id/accept — staff confirm a pending booking. The
// customer gets the "your booking is confirmed" email now, ahead of arrival.
router.post('/:id/accept', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const booking = await db.prepare('SELECT * FROM bookings WHERE id = ? AND carpark_id = ?').get(req.params.id, carparkId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== 'pending') {
      return res.status(400).json({ error: `This booking is already ${booking.status}.` });
    }

    await db.prepare(`UPDATE bookings SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE id = ? AND carpark_id = ?`)
      .run(req.params.id, carparkId);

    const { userId, userName } = actorFromReq(req);
    await logActivity(db, {
      carparkId, tableName: 'bookings', recordId: booking.id, action: 'accept',
      before: { status: booking.status }, after: { status: 'confirmed' },
      notes: `Accepted pre-booking for ${booking.first_name} ${booking.last_name} (${booking.rego})`, userId, userName,
    });

    await notifyCustomerBookingConfirmed(booking);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/prebookings/:id — staff correct a booking that's still active
// (customer rang to change dates, typo in the rego, etc.). If it was already
// confirmed and the drop-off/pick-up changed, the customer is told.
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const booking = await db.prepare('SELECT * FROM bookings WHERE id = ? AND carpark_id = ?').get(req.params.id, carparkId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!ACTIVE_STATUSES.includes(booking.status)) {
      return res.status(400).json({ error: `This booking is already ${booking.status} and can't be edited here.` });
    }

    const body = req.body || {};
    const pick = (key, current) => (body[key] !== undefined ? String(body[key] || '').trim() : current);

    const rego = pick('rego', booking.rego).toUpperCase();
    const dateIn = pick('dateIn', String(booking.date_in).slice(0, 10));
    const dateOut = pick('dateOut', String(booking.date_out).slice(0, 10));
    const timeIn = pick('timeIn', booking.time_in || '');
    const timeOut = pick('timeOut', booking.time_out || '');

    if (!rego) return res.status(400).json({ error: 'Vehicle registration is required' });
    if (!isValidYmd(dateIn) || !isValidYmd(dateOut)) {
      return res.status(400).json({ error: 'Drop-off and pick-up dates are required (YYYY-MM-DD)' });
    }
    if (timeIn && !isValidHm(timeIn)) return res.status(400).json({ error: 'Drop-off time must be HH:MM' });
    if (timeOut && !isValidHm(timeOut)) return res.status(400).json({ error: 'Pick-up time must be HH:MM' });
    if (dateOut < dateIn) return res.status(400).json({ error: 'Pick-up date cannot be before the drop-off date' });
    if (dateOut === dateIn && timeIn && timeOut && timeOut <= timeIn) {
      return res.status(400).json({ error: 'Pick-up time must be after drop-off time on the same day' });
    }

    const next = {
      rego,
      vehicle_make: pick('vehicleMake', booking.vehicle_make || '') || null,
      vehicle_model: pick('vehicleModel', booking.vehicle_model || '') || null,
      vehicle_color: pick('vehicleColor', booking.vehicle_color || '') || null,
      phone: pick('phone', booking.phone || '') || null,
      email: pick('email', booking.email || '') || null,
      date_in: dateIn,
      time_in: timeIn || null,
      date_out: dateOut,
      time_out: timeOut || null,
      notes: pick('notes', booking.notes || '') || null,
    };

    await db.prepare(`
      UPDATE bookings SET
        rego = ?, vehicle_make = ?, vehicle_model = ?, vehicle_color = ?, phone = ?, email = ?,
        date_in = ?, time_in = ?, date_out = ?, time_out = ?, notes = ?
      WHERE id = ? AND carpark_id = ?
    `).run(
      next.rego, next.vehicle_make, next.vehicle_model, next.vehicle_color, next.phone, next.email,
      next.date_in, next.time_in, next.date_out, next.time_out, next.notes,
      req.params.id, carparkId
    );

    const { userId, userName } = actorFromReq(req);
    await logActivity(db, {
      carparkId, tableName: 'bookings', recordId: booking.id, action: 'update',
      before: booking, after: { ...booking, ...next },
      notes: `Edited pre-booking for ${booking.first_name} ${booking.last_name}`, userId, userName,
    });

    const datesChanged =
      String(booking.date_in).slice(0, 10) !== next.date_in ||
      String(booking.date_out).slice(0, 10) !== next.date_out ||
      (booking.time_in || null) !== next.time_in ||
      (booking.time_out || null) !== next.time_out;
    const emailed = booking.status === 'confirmed' && datesChanged;
    if (emailed) {
      await notifyCustomerBookingUpdated({ ...booking, ...next });
    }

    res.json({ success: true, customerEmailed: emailed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prebookings/:id/allocate — marks a booking allocated once staff
// have saved the real check-in invoice for it. If the customer was already
// sent the confirmation at accept time, they aren't emailed it a second time.
router.post('/:id/allocate', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const invoiceId = req.body?.invoiceId;
    if (!invoiceId) return res.status(400).json({ error: 'invoiceId is required' });

    const booking = await db.prepare('SELECT * FROM bookings WHERE id = ? AND carpark_id = ?').get(req.params.id, carparkId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!ACTIVE_STATUSES.includes(booking.status)) {
      return res.status(400).json({ error: `This booking is already ${booking.status}.` });
    }

    await db.prepare(`UPDATE bookings SET status = 'allocated', invoice_id = ? WHERE id = ? AND carpark_id = ?`)
      .run(invoiceId, req.params.id, carparkId);

    if (booking.status === 'pending') {
      await notifyCustomerBookingAllocated(booking);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prebookings/:id/cancel — staff cancel a booking that hasn't been
// checked in yet (customer called it in, or it's clearly not going ahead).
// Once a booking is already allocated to a real invoice, cancel that invoice
// instead.
router.post('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const booking = await db.prepare('SELECT * FROM bookings WHERE id = ? AND carpark_id = ?').get(req.params.id, carparkId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!ACTIVE_STATUSES.includes(booking.status)) {
      return res.status(400).json({ error: `This booking is already ${booking.status}.` });
    }

    await db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ? AND carpark_id = ?`).run(req.params.id, carparkId);
    await notifyCustomerBookingCancelled(booking);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prebookings/:id/no-show — staff mark a booking as a no-show
// (customer never turned up for drop-off).
router.post('/:id/no-show', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const booking = await db.prepare('SELECT * FROM bookings WHERE id = ? AND carpark_id = ?').get(req.params.id, carparkId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!ACTIVE_STATUSES.includes(booking.status)) {
      return res.status(400).json({ error: `This booking is already ${booking.status}.` });
    }

    await db.prepare(`UPDATE bookings SET status = 'no_show' WHERE id = ? AND carpark_id = ?`).run(req.params.id, carparkId);
    await notifyCustomerNoShow(booking);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
