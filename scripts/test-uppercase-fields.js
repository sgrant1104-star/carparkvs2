#!/usr/bin/env node
/**
 * Validates names/registrations are always normalised to upper case before
 * saving, whatever way staff typed them.
 */
const { withUppercaseFields } = require('../src/utils/textCase');

let fail = false;
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail = true; } else { console.log('PASS:', msg); } };

const out = withUppercaseFields({ rego: ' nea938 ', first_name: 'maria and Warwick', last_name: 'hunt', phone: '021abc', email: 'a@b.co', notes: 'keep Case' });
assert(out.rego === 'NEA938', 'rego upper-cased and trimmed');
assert(out.first_name === 'MARIA AND WARWICK' && out.last_name === 'HUNT', 'first and last name upper-cased');
assert(out.phone === '021abc' && out.email === 'a@b.co' && out.notes === 'keep Case', 'phone, email and notes are left alone');

const lt = withUppercaseFields({ name: 'jo bloggs', rego_1: 'abc123', rego_2: null });
assert(lt.name === 'JO BLOGGS' && lt.rego_1 === 'ABC123' && lt.rego_2 === null, 'long-term name/regos upper-cased, null stays null');

const acct = withUppercaseFields({ company_name: 'Ngati Kahu Social & Health', rego_1: 'xyz9' }, ['rego_1', 'rego_2']);
assert(acct.company_name === 'Ngati Kahu Social & Health' && acct.rego_1 === 'XYZ9', 'account company names keep their case; account regos upper-cased');

const original = { rego: 'abc' };
withUppercaseFields(original);
assert(original.rego === 'abc', 'input object is not mutated');
assert(withUppercaseFields(undefined) && typeof withUppercaseFields(null) === 'object', 'missing body is safe');

console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(fail ? 1 : 0);
