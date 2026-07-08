/**
 * Calendar day from date_in (optional table alias e.g. "i" → i.date_in).
 */
function invDay(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `substr(trim(COALESCE(${p}date_in,'')), 1, 10)`;
}

/**
 * Effective settlement day for payment line 1 / 2 (banking, EOD, reports vs terminal).
 * Legacy rows with blank payment_date_* fall back to date_in so paid amounts are not lost.
 */
function effectivePay1Day(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `(CASE WHEN trim(COALESCE(${p}payment_date_1,'')) != '' THEN substr(trim(COALESCE(${p}payment_date_1,'')),1,10) ELSE ${invDay(alias)} END)`;
}

function effectivePay2Day(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `(CASE WHEN COALESCE(${p}payment_amount_2,0) > 0 AND trim(COALESCE(${p}paid_status_2,'')) != '' AND trim(COALESCE(${p}paid_status_2,'')) != 'To Pay' THEN (CASE WHEN trim(COALESCE(${p}payment_date_2,'')) != '' THEN substr(trim(COALESCE(${p}payment_date_2,'')),1,10) ELSE ${invDay(alias)} END) ELSE NULL END)`;
}

function l1Eftpos(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `(CASE WHEN ${p}paid_status = 'Eftpos' THEN COALESCE(${p}payment_amount,0) ELSE 0 END)`;
}
function l1Cash(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `(CASE WHEN ${p}paid_status = 'Cash' THEN COALESCE(${p}payment_amount,0) ELSE 0 END)`;
}
function l1OnAcc(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `(CASE WHEN ${p}paid_status = 'OnAcc' THEN COALESCE(${p}payment_amount,0) ELSE 0 END)`;
}
function l1InternetBanking(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `(CASE WHEN ${p}paid_status = 'Internet Banking' THEN COALESCE(${p}payment_amount,0) ELSE 0 END)`;
}
function l1PaidTotal(alias = '') {
  return `(${l1Eftpos(alias)} + ${l1Cash(alias)} + ${l1OnAcc(alias)} + ${l1InternetBanking(alias)})`;
}
function l2Eftpos(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `(CASE WHEN ${p}paid_status_2 = 'Eftpos' THEN COALESCE(${p}payment_amount_2,0) ELSE 0 END)`;
}
function l2Cash(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `(CASE WHEN ${p}paid_status_2 = 'Cash' THEN COALESCE(${p}payment_amount_2,0) ELSE 0 END)`;
}
function l2OnAcc(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `(CASE WHEN ${p}paid_status_2 = 'OnAcc' THEN COALESCE(${p}payment_amount_2,0) ELSE 0 END)`;
}
function l2InternetBanking(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `(CASE WHEN ${p}paid_status_2 = 'Internet Banking' THEN COALESCE(${p}payment_amount_2,0) ELSE 0 END)`;
}
function l2PaidTotal(alias = '') {
  return `(${l2Eftpos(alias)} + ${l2Cash(alias)} + ${l2OnAcc(alias)} + ${l2InternetBanking(alias)})`;
}

const EFFECTIVE_PAY1_DAY = effectivePay1Day();
const EFFECTIVE_PAY2_DAY = effectivePay2Day();
const L1_EFTPOS = l1Eftpos();
const L1_CASH = l1Cash();
const L1_ONACC = l1OnAcc();
const L1_PAID_TOTAL = l1PaidTotal();
const L2_EFTPOS = l2Eftpos();
const L2_CASH = l2Cash();
const L2_ONACC = l2OnAcc();
const L2_PAID_TOTAL = l2PaidTotal();

function sumLine1InRange(amountExpr) {
  return `COALESCE(SUM(CASE WHEN (${EFFECTIVE_PAY1_DAY}) >= ? AND (${EFFECTIVE_PAY1_DAY}) <= ? THEN (${amountExpr}) ELSE 0 END), 0)`;
}

function sumLine2InRange(amountExpr) {
  return `COALESCE(SUM(CASE WHEN (${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) >= ? AND (${EFFECTIVE_PAY2_DAY}) <= ? THEN (${amountExpr}) ELSE 0 END), 0)`;
}

function sumBothLinesInRange(amountExpr1, amountExpr2) {
  return `(${sumLine1InRange(amountExpr1)} + ${sumLine2InRange(amountExpr2)})`;
}

module.exports = {
  invDay,
  effectivePay1Day,
  effectivePay2Day,
  l1Eftpos,
  l1Cash,
  l1OnAcc,
  l1InternetBanking,
  l1PaidTotal,
  l2Eftpos,
  l2Cash,
  l2OnAcc,
  l2InternetBanking,
  l2PaidTotal,
  EFFECTIVE_PAY1_DAY,
  EFFECTIVE_PAY2_DAY,
  L1_EFTPOS,
  L1_CASH,
  L1_ONACC,
  L1_PAID_TOTAL,
  L2_EFTPOS,
  L2_CASH,
  L2_ONACC,
  L2_PAID_TOTAL,
  sumLine1InRange,
  sumLine2InRange,
  sumBothLinesInRange,
};
