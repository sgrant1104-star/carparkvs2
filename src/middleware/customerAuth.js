// Customer portal auth guard. Deliberately independent of src/middleware/auth.js
// (staff): reads req.customerSession, which is only ever populated by decoding
// the 'customer_auth_token' cookie — a staff 'auth_token' cookie can never
// satisfy this, and this can never satisfy requireAuth/requireAdmin.
//
// Always returns JSON 401 — never redirects. Every portal page is a static
// HTML file whose own inline script gates access by calling an API and
// redirecting client-side on failure; there is no server-rendered page
// behind these routes to redirect to. A redirect branch here previously
// caused a real bug: fetch() follows redirects transparently, so a 302 to
// login.html (which itself returns 200 OK HTML) made callers see `r.ok`
// as true even while logged out.
function requireCustomerAuth(req, res, next) {
  if (req.customerSession && req.customerSession.customerId) {
    return next();
  }
  res.status(401).json({ error: 'Not authenticated' });
}

module.exports = { requireCustomerAuth };
