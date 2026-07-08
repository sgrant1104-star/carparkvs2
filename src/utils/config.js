const crypto = require('crypto');

// ─── Session / JWT secret ──────────────────────────────────────────────────
// Previously this fell back to a hardcoded string ('carpark_secret_2026')
// baked into source. Anyone who read the code could forge an admin JWT.
//
// Now: if SESSION_SECRET is set in the environment, use it (required for
// sessions to survive a restart / for multi-instance deployments). If it's
// NOT set, generate a random secret once per process and warn loudly — the
// app still works for a single dev/demo session, but every restart
// invalidates existing logins instead of accepting a guessable default.
let _generatedSecret = null;
let _warned = false;

function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!_generatedSecret) {
    _generatedSecret = crypto.randomBytes(48).toString('hex');
  }
  if (!_warned) {
    _warned = true;
    console.warn('[SECURITY] SESSION_SECRET is not set in the environment.');
    console.warn('[SECURITY] Using a random secret generated for this process only — all sessions will be');
    console.warn('[SECURITY] invalidated on the next restart. Set SESSION_SECRET (a long random string) in');
    console.warn('[SECURITY] your environment (Railway/Vercel/local .env) before going to production.');
  }
  return _generatedSecret;
}

module.exports = { getSessionSecret };
