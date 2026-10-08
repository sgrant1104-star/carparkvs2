/** Splits a multi-line "Bill to" block into trimmed, non-empty lines. */
function billingAddressLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

module.exports = { billingAddressLines };
