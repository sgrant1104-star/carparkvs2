// Shared short-stay pricing calculation — single source of truth used by
// both the staff check-in form (GET /api/invoices/calculate-price) and the
// customer portal's booking estimate (GET /api/bookings/estimate-price), so
// a rate change in Admin → Pricing is reflected in both places automatically.

const ACCOUNT_RATE_CARD = {
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

async function calculateShortStayPrice(db, { carparkId, nights, accountCustomerId }) {
  const n = parseInt(nights) || 1;

  if (accountCustomerId && ACCOUNT_RATE_CARD[n]) {
    const dailyRate = ACCOUNT_RATE_CARD[n];
    const total = Math.round((dailyRate * n) * 100) / 100;
    return { nights: n, dailyRate, total, discountPercent: 0, pricing_mode: 'account_rate_card' };
  }

  let discountPercent = 0;
  if (accountCustomerId) {
    const acct = await db.prepare('SELECT discount_percent FROM account_customers WHERE id = ?').get(accountCustomerId);
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

  return { nights: n, dailyRate, total: Math.round(total * 100) / 100, discountPercent, pricing_mode: 'standard' };
}

module.exports = { calculateShortStayPrice };
