// Booking notification emails — reuses the same SMTP setup as password
// reset / invoice emails (src/utils/mailer.js). Every function here is
// fire-and-forget: a failed or unconfigured send is logged and swallowed,
// never allowed to block the booking action that triggered it.

const { getTransporter, emailFrom, smtpErrorMessage } = require('./mailer');

function adminNotifyEmail() {
  const configured = (process.env.BOOKING_NOTIFY_EMAIL || '').trim();
  if (configured) return configured;
  return (process.env.SMTP_USER || '').trim();
}

function vehicleLine(b) {
  return [b.vehicleMake, b.vehicleModel, b.vehicleColor].filter(Boolean).join(' ') || null;
}

function wrap(title, bodyHtml) {
  return `<!DOCTYPE html><html><body style="font-family:Arial;max-width:600px;margin:0 auto;padding:20px;">
    <h2 style="color:#1a5276;">${title}</h2>
    ${bodyHtml}
  </body></html>`;
}

function detailsTable(b) {
  const rows = [
    ['Customer', `${b.first_name || b.firstName || ''} ${b.last_name || b.lastName || ''}`.trim()],
    ['Phone', b.phone || '—'],
    ['Rego', b.rego || '—'],
    ['Vehicle', vehicleLine(b) || '—'],
    ['Drop-off', `${b.date_in || b.dateIn}${(b.time_in || b.timeIn) ? ' ' + (b.time_in || b.timeIn) : ''}`],
    ['Pick-up', `${b.date_out || b.dateOut}${(b.time_out || b.timeOut) ? ' ' + (b.time_out || b.timeOut) : ''}`],
  ];
  if (b.notes) rows.push(['Notes', b.notes]);
  return `<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;">
    ${rows.map(([k, v]) => `<tr><td style="color:#666;padding:4px 10px 4px 0;white-space:nowrap;">${k}</td><td style="font-weight:bold;">${v}</td></tr>`).join('')}
  </table>`;
}

async function send(to, subject, html, logLabel) {
  if (!to) return;
  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`[booking-email] SMTP not configured — skipped "${logLabel}" to ${to}`);
    return;
  }
  try {
    await transporter.sendMail({ from: emailFrom(), to, subject, html });
  } catch (err) {
    console.error(`[booking-email] Failed to send "${logLabel}" to ${to}:`, smtpErrorMessage(err));
  }
}

// A new booking request has come in — notify the business.
async function notifyAdminNewBooking(booking) {
  const to = adminNotifyEmail();
  const base = appUrl();
  const link = base ? `<p style="margin-top:16px;"><a href="${base}/prebookings.html" style="color:#1a5276;">View in Pre-Bookings</a></p>` : '';
  const flags = [];
  if (booking.is_long_term) flags.push('LONG-TERM REQUEST — needs an individual quote, not standard pricing.');
  if (booking.account_company_name) flags.push(`ON ACCOUNT: ${booking.account_company_name}`);
  const banner = flags.length
    ? `<p style="background:#fff3cd;border:1px solid #ffe69c;padding:10px 14px;border-radius:6px;color:#664d03;font-weight:bold;">${flags.join('<br>')}</p>`
    : '';
  const html = wrap('New online booking request', `
    <p>A new booking request just came in.</p>
    ${banner}
    ${detailsTable(booking)}
    ${link}
  `);
  await send(to, 'New online booking request', html, 'admin: new booking');
}

// Customer just submitted — confirm we received it (not yet confirmed by staff).
async function notifyCustomerBookingSubmitted(booking) {
  const html = wrap('Booking request received', `
    <p>Hi ${booking.first_name || booking.firstName || ''},</p>
    <p>Thanks — we've received your booking request. Our team will confirm your spot before your drop-off date.</p>
    ${detailsTable(booking)}
    <p style="margin-top:16px;color:#666;">Payment is taken on arrival — nothing has been charged.</p>
  `);
  await send(booking.email, 'Booking request received - BOI Car Storage', html, 'customer: submitted');
}

// Staff allocated the booking to a real spot.
async function notifyCustomerBookingAllocated(booking) {
  const html = wrap('Your booking is confirmed', `
    <p>Hi ${booking.first_name || booking.firstName || ''},</p>
    <p>Good news — your parking booking is confirmed.</p>
    ${detailsTable(booking)}
    <p style="margin-top:16px;color:#666;">Payment is taken on arrival — nothing has been charged.</p>
  `);
  await send(booking.email, 'Your booking is confirmed - BOI Car Storage', html, 'customer: allocated');
}

// Staff cancelled a booking — let the customer know.
async function notifyCustomerBookingCancelled(booking) {
  const html = wrap('Your booking has been cancelled', `
    <p>Hi ${booking.first_name || booking.firstName || ''},</p>
    <p>Your parking booking below has been cancelled. Get in touch if this doesn't look right.</p>
    ${detailsTable(booking)}
  `);
  await send(booking.email, 'Your booking has been cancelled - BOI Car Storage', html, 'customer: cancelled by staff');
}

// Customer cancelled their own booking — let the business know.
async function notifyAdminBookingCancelledByCustomer(booking) {
  const to = adminNotifyEmail();
  const html = wrap('Customer cancelled a booking', `
    <p>A customer cancelled their upcoming booking.</p>
    ${detailsTable(booking)}
  `);
  await send(to, 'Customer cancelled a booking', html, 'admin: cancelled by customer');
}

// Staff marked the booking a no-show.
async function notifyCustomerNoShow(booking) {
  const html = wrap('Missed booking', `
    <p>Hi ${booking.first_name || booking.firstName || ''},</p>
    <p>We've marked your booking below as a no-show, since we didn't see you at the expected drop-off time.
    If this isn't right, please get in touch.</p>
    ${detailsTable(booking)}
  `);
  await send(booking.email, 'Missed booking - BOI Car Storage', html, 'customer: no-show');
}

// Nobody allocated the booking before the drop-off date ended — expired,
// not manually cancelled. Customer-only; staff already see it drop off the
// Pre-Bookings list, so a separate admin email would just be noise.
async function notifyCustomerBookingAutoCancelled(booking) {
  const html = wrap('Your booking has expired', `
    <p>Hi ${booking.first_name || booking.firstName || ''},</p>
    <p>We weren't able to confirm your booking before its drop-off date, so it's now expired.
    If you still need parking, please submit a new booking or get in touch.</p>
    ${detailsTable(booking)}
  `);
  await send(booking.email, 'Your booking has expired - BOI Car Storage', html, 'customer: auto-cancelled');
}

function appUrl() {
  const explicit = (process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
  if (explicit) return explicit;
  const railwayDomain = (process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  if (railwayDomain) return `https://${railwayDomain}`;
  return '';
}

module.exports = {
  notifyAdminNewBooking,
  notifyCustomerBookingSubmitted,
  notifyCustomerBookingAllocated,
  notifyCustomerBookingCancelled,
  notifyAdminBookingCancelledByCustomer,
  notifyCustomerNoShow,
  notifyCustomerBookingAutoCancelled,
};
