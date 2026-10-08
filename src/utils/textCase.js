/**
 * Names and registrations are always stored upper case, however staff type
 * them. The booking form used to only DISPLAY them in capitals (a CSS style),
 * so whatever was typed — "nea938", "maria and Warwick hunt" — was saved
 * as-is. Doing it here, on the server, covers every way a record can be
 * created or edited.
 */

const UPPERCASE_FIELDS = ['rego', 'rego_1', 'rego_2', 'first_name', 'last_name', 'name'];

/** Returns a shallow copy of body with the name/rego fields upper-cased and trimmed. */
function withUppercaseFields(body, fields = UPPERCASE_FIELDS) {
  const out = { ...(body || {}) };
  for (const f of fields) {
    if (typeof out[f] === 'string') out[f] = out[f].trim().toUpperCase();
  }
  return out;
}

module.exports = { withUppercaseFields, UPPERCASE_FIELDS };
