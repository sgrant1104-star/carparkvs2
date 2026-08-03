// Customer portal auth guard. Deliberately independent of src/middleware/auth.js
// (staff): reads req.customerSession, which is only ever populated by decoding
// the 'customer_auth_token' cookie — a staff 'auth_token' cookie can never
// satisfy this, and this can never satisfy requireAuth/requireAdmin.
function requireCustomerAuth(req, res, next) {
  if (req.customerSession && req.customerSession.customerId) {
    return next();
  }
  if (req.xhr || (req.headers.accept || '').indexOf('json') > -1) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/portal/login.html');
}

module.exports = { requireCustomerAuth };
