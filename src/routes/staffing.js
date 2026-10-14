const express = require('express');
const crypto = require('crypto');
const { db } = require('../database');
const router = express.Router();

// Read-only feed for the staff roster app: how many yard customers come back for their keys, per day and hour,
// so the airport desk can roster for the handovers. Counts only (no names, regos or contact details).
// Needs STAFFING_TOKEN, sent as "Authorization: Bearer <token>".
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

function authorised(req) {
  const token = process.env.STAFFING_TOKEN || '';
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || got.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token));
}

router.get('/returns', async (req, res) => {
  try {
    if (!authorised(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { from, to } = req.query;
    if (!isYmd(from) || !isYmd(to) || to < from) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 90) return res.status(400).json({ error: 'At most 90 days' });
    const carparkId = Number(req.query.carpark_id) || 1;

    // Cars in the yard due back in the range (same "in yard" rule as the Returns screen), and bookings that haven't
    // arrived yet (pending/confirmed, not yet turned into an invoice) collecting in the range.
    const inYard = await db.prepare(`
      SELECT DATE(return_date) AS d, return_time AS t FROM invoices
      WHERE carpark_id = ? AND void = 0 AND (picked_up IS NULL OR picked_up = '' OR picked_up = 'Car In Yard')
        AND DATE(return_date) BETWEEN ? AND ?`).all(carparkId, from, to);
    const booked = await db.prepare(`
      SELECT DATE(date_out) AS d, time_out AS t FROM bookings
      WHERE carpark_id = ? AND status IN ('pending', 'confirmed') AND invoice_id IS NULL
        AND DATE(date_out) BETWEEN ? AND ?`).all(carparkId, from, to);

    const days = {};
    for (const r of [...inYard.map(x => ({ ...x, src: 'yard' })), ...booked.map(x => ({ ...x, src: 'booked' }))]) {
      if (!isYmd(r.d)) continue;
      const day = days[r.d] = days[r.d] || { date: r.d, total: 0, in_yard: 0, booked: 0, hours: {}, no_time: 0 };
      day.total++;
      day[r.src === 'yard' ? 'in_yard' : 'booked']++;
      const m = /^(\d{1,2}):\d{2}/.exec(String(r.t || ''));
      if (m && Number(m[1]) < 24) day.hours[Number(m[1])] = (day.hours[Number(m[1])] || 0) + 1;
      else day.no_time++;
    }
    res.json({ from, to, days: Object.values(days).sort((a, b) => a.date.localeCompare(b.date)) });
  } catch (err) {
    console.error('Staffing feed error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
