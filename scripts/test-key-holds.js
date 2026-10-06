#!/usr/bin/env node
/**
 * Validates key holds — the thing that stops two open booking forms being
 * offered the same key:
 * 1) A second form is offered a different key than the first.
 * 2) Re-asking with the same token keeps its key (stable across refreshes).
 * 3) A specific key held by another form can't be taken.
 * 4) Releasing frees the key for others.
 * 5) Holds are per carpark, and a form only ever holds one key at a time.
 * 6) Expired holds free themselves.
 */
const { heldByOther, keysHeldByOthers, releaseToken, holdKey, pickAndHold } = require('../src/utils/keyHolds');

let fail = false;
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail = true; } else { console.log('PASS:', msg); } };

const avail = [3, 4, 5, 6];

const a = pickAndHold(1, 'tabA', avail);
const b = pickAndHold(1, 'tabB', avail);
assert(a === 3, `first form gets lowest free key (got ${a})`);
assert(b === 4, `second form is offered a DIFFERENT key (got ${b})`);

assert(pickAndHold(1, 'tabA', avail) === 3, 'same token re-asking keeps its key');
assert(heldByOther(1, 3, 'tabB') === true, 'key 3 is seen as held by another form');
assert(heldByOther(1, 3, 'tabA') === false, 'key 3 is not "held by another" for its own holder');

assert(holdKey(1, 3, 'tabB') === false, 'cannot take a specific key another form holds');
assert(holdKey(1, 5, 'tabB') === true, 'can switch to a free specific key');
assert(keysHeldByOthers(1, 'tabA').has(5) && !keysHeldByOthers(1, 'tabA').has(4), 'switching releases the form\'s previous key (4 freed, 5 held)');

releaseToken(1, 'tabA');
assert(heldByOther(1, 3, 'tabB') === false, 'released key is free again');
assert(pickAndHold(1, 'tabC', avail) === 3, 'next form is offered the released key');

assert(heldByOther(2, 3, 'tabB') === false, 'holds are per carpark');

// Everything held -> nothing to offer
['t1', 't2', 't3'].forEach((t) => pickAndHold(1, t, [7, 8, 9]));
assert(pickAndHold(1, 't4', [7, 8, 9]) === null, 'returns null when every free key is held');

// Expiry
const realNow = Date.now;
Date.now = () => realNow() + 11 * 60 * 1000;
assert(heldByOther(1, 3, 'someoneElse') === false, 'hold expires after 10 minutes');
Date.now = realNow;

console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(fail ? 1 : 0);
