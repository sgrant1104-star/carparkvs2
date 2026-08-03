const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { notifyCustomerBookingAllocated, notifyCustomerBookingCancelled, notifyCustomerNoShow } = require('../utils/bookingEmails');
const router = express.Router();

function ymdToday() {
  return new Date().toISOString().slice(0, 10);
}

function publicPrebooking(b, todayYmd) {
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
    overdue: String(b.date_in).slice(0, 10) < todayYmd,
  };
}

// GET /api/prebookings — pending customer-submitted bookings staff still need
// to allocate to a real spot. Oldest date_in first (most overdue surfaces
// first); nothing is filtered out by date, since a booking whose date_in has
// already passed still needs handling, not hiding.
router.get('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const today = ymdToday();
    const bookings = await db.prepare(`
      SELECT * FROM bookings WHERE carpark_id = ? AND status = 'pending'
      ORDER BY date_in ASC, created_at ASC
    `).all(carparkId);
    res.json(bookings.map((b) => publicPrebooking(b, today)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prebookings/:id — single booking detail, used by invoice.html to
// prefill the check-in form when staff click "Allocate".
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const booking = await db.prepare('SELECT * FROM bookings WHERE id = ? AND carpark_id = ?').get(req.params.id, carparkId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    res.json(publicPrebooking(booking, ymdToday()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prebookings/:id/allocate — marks a booking allocated once staff
// have saved the real check-in invoice for it.
router.post('/:id/allocate', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const invoiceId = req.body?.invoiceId;
    if (!invoiceId) return res.status(400).json({ error: 'invoiceId is required' });

    const booking = await db.prepare('SELECT * FROM bookings WHERE id = ? AND carpark_id = ?').get(req.params.id, carparkId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    await db.prepare(`UPDATE bookings SET status = 'allocated', invoice_id = ? WHERE id = ? AND carpark_id = ?`)
      .run(invoiceId, req.params.id, carparkId);

    await notifyCustomerBookingAllocated(booking);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prebookings/:id/cancel — staff cancel a pending booking (e.g.
// customer called it in, or it's clearly not going ahead). Once a booking is
// already allocated to a real invoice, cancel that invoice instead.
router.post('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const booking = await db.prepare('SELECT * FROM bookings WHERE id = ? AND carpark_id = ?').get(req.params.id, carparkId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== 'pending') {
      return res.status(400).json({ error: `This booking is already ${booking.status}.` });
    }

    await db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ? AND carpark_id = ?`).run(req.params.id, carparkId);
    await notifyCustomerBookingCancelled(booking);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prebookings/:id/no-show — staff mark a pending booking as a
// no-show (customer never turned up for drop-off).
router.post('/:id/no-show', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const booking = await db.prepare('SELECT * FROM bookings WHERE id = ? AND carpark_id = ?').get(req.params.id, carparkId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== 'pending') {
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
