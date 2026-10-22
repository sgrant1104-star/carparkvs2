/**
 * Builds an AND-of-words search clause. Each word must match at least one of
 * the columns, so "karen markin" finds KAREN / MARKIN even though no single
 * column contains both words. (Searches used to LIKE the whole phrase against
 * each column separately, so typing a full name found nothing.)
 *
 * Returns { sql, params } — sql is '' when there is nothing to search for,
 * otherwise a string beginning with " AND (" ready to append to a WHERE.
 */
function wordSearchClause(columns, search) {
  const words = String(search || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { sql: '', params: [] };
  const params = [];
  const perWord = words.map((w) => {
    const like = `%${w}%`;
    columns.forEach(() => params.push(like));
    return `(${columns.map((c) => `${c} LIKE ?`).join(' OR ')})`;
  });
  return { sql: ` AND (${perWord.join(' AND ')})`, params };
}

module.exports = { wordSearchClause };
