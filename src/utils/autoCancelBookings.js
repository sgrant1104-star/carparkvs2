// Flips still-pending online bookings to 'auto_cancelled' once their
// drop-off date has fully ended, in NZ time — matching businessDateYmd(),
// the same "today" the rest of the app already uses for reports/dashboard.
// Deliberately calendar-day based, not drop-off-time based: a booking gets
// the whole of its drop-off day as a grace window before it expires, so a
// same-day delay (flight, etc.) doesn't get it cancelled out from under staff.

const { db } = require('../database');
const { businessDateYmd } = require('./businessDate');
const { notifyCustomerBookingAutoCancelled } = require('./bookingEmails');

async function autoCancelOverdueBookings() {
  const today = businessDateYmd();

  const overdue = await db.prepare(`
    SELECT * FROM bookings WHERE status = 'pending' AND date_in < ?
  `).all(today);

  for (const booking of overdue) {
    await db.prepare(`UPDATE bookings SET status = 'auto_cancelled' WHERE id = ?`).run(booking.id);
    await notifyCustomerBookingAutoCancelled(booking);
  }

  return { checked: overdue.length, cancelledIds: overdue.map((b) => b.id) };
}

module.exports = { autoCancelOverdueBookings };
