const express = require('express');
const { db } = require('../database');
const { requireCustomerAuth } = require('../middleware/customerAuth');
const router = express.Router();

function isValidYmd(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
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
    dateOut: b.date_out,
    status: b.status,
    notes: b.notes,
    createdAt: b.created_at,
  };
}

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
    const dateOut = String(req.body?.dateOut || '').trim();
    const notes = String(req.body?.notes || '').trim();

    if (!rego) return res.status(400).json({ error: 'Vehicle registration is required' });
    if (!isValidYmd(dateIn) || !isValidYmd(dateOut)) {
      return res.status(400).json({ error: 'Drop-off and pick-up dates are required (YYYY-MM-DD)' });
    }
    if (dateOut < dateIn) return res.status(400).json({ error: 'Pick-up date cannot be before the drop-off date' });

    const customer = await db.prepare('SELECT * FROM customer_accounts WHERE id = ?').get(customerId);
    if (!customer) return res.status(401).json({ error: 'Not authenticated' });

    const result = await db.prepare(`
      INSERT INTO bookings
        (carpark_id, customer_account_id, first_name, last_name, phone, email,
         rego, vehicle_make, vehicle_model, vehicle_color, date_in, date_out, notes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      carparkId, customerId, customer.first_name, customer.last_name, customer.phone, customer.email,
      rego, vehicleMake || null, vehicleModel || null, vehicleColor || null, dateIn, dateOut, notes || null
    );

    const booking = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, booking: publicBooking(booking) });
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
