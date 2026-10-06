/**
 * Soft, short-lived holds on key-box numbers while a booking form is open.
 *
 * Without this, every open form is offered the same "lowest free key" and the
 * clash is only found at save (after all the typing). A hold reserves a key
 * for one open form (identified by a random token the page generates) so the
 * next form is offered a different one. Holds are in-memory on purpose: they
 * are a convenience, not the source of truth — the key_box table (and
 * checkKeyConflict at save) still decides who actually owns a key, and a
 * restart simply drops the holds.
 */

const HOLD_TTL_MS = 10 * 60 * 1000;
const holds = new Map(); // `${carparkId}:${key}` -> { token, expires }

const mapKey = (carparkId, key) => `${carparkId}:${Number(key)}`;

function prune(now = Date.now()) {
  for (const [k, h] of holds) if (h.expires <= now) holds.delete(k);
}

function heldByOther(carparkId, key, token) {
  prune();
  const h = holds.get(mapKey(carparkId, key));
  return !!h && h.token !== token;
}

function keysHeldByOthers(carparkId, token) {
  prune();
  const out = new Set();
  for (const [k, h] of holds) {
    const [cp, key] = k.split(':');
    if (Number(cp) === Number(carparkId) && h.token !== token) out.add(Number(key));
  }
  return out;
}

function currentHoldFor(carparkId, token) {
  prune();
  for (const [k, h] of holds) {
    const [cp, key] = k.split(':');
    if (Number(cp) === Number(carparkId) && h.token === token) return Number(key);
  }
  return null;
}

function releaseToken(carparkId, token) {
  for (const [k, h] of holds) {
    const [cp] = k.split(':');
    if (Number(cp) === Number(carparkId) && h.token === token) holds.delete(k);
  }
}

/** Hold `key` for `token` (replacing any other key this token held). False if someone else holds it. */
function holdKey(carparkId, key, token) {
  if (heldByOther(carparkId, key, token)) return false;
  releaseToken(carparkId, token);
  holds.set(mapKey(carparkId, key), { token, expires: Date.now() + HOLD_TTL_MS });
  return true;
}

/**
 * Pick the lowest key from `availableKeys` that nobody else is holding, hold
 * it, and return it (null if none). Re-asking with the same token keeps its
 * existing key when that key is still available, so refreshes are stable.
 */
function pickAndHold(carparkId, token, availableKeys) {
  const mine = currentHoldFor(carparkId, token);
  if (mine != null && availableKeys.includes(mine)) {
    holdKey(carparkId, mine, token);
    return mine;
  }
  const others = keysHeldByOthers(carparkId, token);
  const pick = availableKeys.find((k) => !others.has(Number(k)));
  if (pick == null) {
    releaseToken(carparkId, token);
    return null;
  }
  holdKey(carparkId, pick, token);
  return pick;
}

module.exports = { HOLD_TTL_MS, heldByOther, keysHeldByOthers, releaseToken, holdKey, pickAndHold };
