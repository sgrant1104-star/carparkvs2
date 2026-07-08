/**
 * Append-only activity log.
 *
 * Call this whenever a route mutates something money-related or deletes a
 * record, so there is always an answer to "who did this, when, and what did
 * the record look like before/after". before/after are plain objects (full
 * row snapshots) — pass `null` for either when not applicable (e.g. `before`
 * is null on create, `after` is null on delete).
 *
 * This never throws into the caller — a logging failure should not block the
 * underlying business operation, but it does log to the console so it's not
 * silently swallowed either.
 */
async function logActivity(db, {
  carparkId = 1,
  tableName,
  recordId = null,
  action,
  before = null,
  after = null,
  notes = null,
  userId = null,
  userName = null,
}) {
  try {
    await db.prepare(`
      INSERT INTO activity_log
        (carpark_id, table_name, record_id, action, before_json, after_json, notes, user_id, user_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      carparkId,
      tableName,
      recordId,
      action,
      before != null ? JSON.stringify(before) : null,
      after != null ? JSON.stringify(after) : null,
      notes,
      userId,
      userName
    );
  } catch (err) {
    console.error(`[audit] Failed to log ${action} on ${tableName}#${recordId}:`, err.message);
  }
}

/** Convenience: pull { userId, userName } out of an authenticated req. */
function actorFromReq(req) {
  return {
    userId: req.session && req.session.userId != null ? req.session.userId : null,
    userName: req.session && req.session.name ? req.session.name : null,
  };
}

module.exports = { logActivity, actorFromReq };
