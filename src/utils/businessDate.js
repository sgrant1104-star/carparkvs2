/**
 * Calendar date (YYYY-MM-DD) in the business timezone (default NZ).
 * Use for dashboard/reports so "today" matches staff in Bay of Islands, not UTC.
 */
const DEFAULT_TZ = process.env.TZ || 'Pacific/Auckland';

function businessDateYmd(date = new Date(), timeZone = DEFAULT_TZ) {
  return date.toLocaleDateString('en-CA', { timeZone });
}

/** Add/subtract whole calendar days to a YYYY-MM-DD string (no DST surprises for date-only storage). */
function addCalendarDaysYmd(ymd, deltaDays) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = t.getUTCFullYear();
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(t.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

module.exports = { businessDateYmd, addCalendarDaysYmd, DEFAULT_TZ };
