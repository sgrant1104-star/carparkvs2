function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  if (req.xhr || req.headers.accept.indexOf('json') > -1) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/login.html');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.userId && req.session.role === 'admin') {
    return next();
  }
  return res.status(403).json({ error: 'Admin access required' });
}

module.exports = { requireAuth, requireAdmin };
