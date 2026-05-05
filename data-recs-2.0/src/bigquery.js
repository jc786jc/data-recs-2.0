/**
 * bigquery.js — BigQuery REST API wrapper
 *
 * Executes queries against any GCP project using the
 * authenticated OAuth token.  No SDK required — pure fetch().
 *
 * Cross-project queries work out of the box: the SQL references
 * `project-b.dataset.table` while the job runs (and is billed)
 * against Project A.
 */

/* ── PUBLIC API ──────────────────────────────────────────────── */

/**
 * Run a BigQuery SQL query and return parsed rows + column names.
 *
 * @param {string} projectId   — GCP project that will run & pay for the job
 * @param {string} sql         — Standard SQL (useLegacySql: false)
 * @param {string} token       — OAuth 2.0 Bearer token
 * @returns {Promise<{cols: string[], rows: object[], totalRows: string}>}
 */
async function runBQQuery(projectId, sql, token, location) {
  const url  = `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/queries`;
  const body = {
    query:        sql,
    useLegacySql: false,
    timeoutMs:    30000,
    maxResults:   1000,
    ...(location ? { location } : {}),
  };

  const resp = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${resp.status}: BigQuery API error`);
  }

  const data = await resp.json();

  // If the job didn't finish within timeoutMs, poll until done
  if (!data.jobComplete) {
    return await pollJobUntilDone(projectId, data.jobReference.jobId, token);
  }

  return parseQueryResponse(data);
}

/* ── PRIVATE HELPERS ─────────────────────────────────────────── */

/**
 * Poll a long-running BigQuery job until it finishes.
 * Retries up to 60 times with a 1-second interval (60 s total).
 */
async function pollJobUntilDone(projectId, jobId, token) {
  const baseUrl = `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/jobs/${jobId}`;

  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(1000);

    const statusResp = await fetch(baseUrl, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    const statusData = await statusResp.json();

    if (statusData.status?.state === 'DONE') {
      if (statusData.status.errorResult) {
        throw new Error(statusData.status.errorResult.message);
      }
      // Fetch the actual result rows
      const resultsResp = await fetch(
        `${baseUrl}/getQueryResults?maxResults=1000`,
        { headers: { 'Authorization': 'Bearer ' + token } }
      );
      const resultsData = await resultsResp.json();
      return parseQueryResponse(resultsData);
    }
  }

  throw new Error('Query timed out after 60 seconds. Try a LIMIT clause or a smaller date range.');
}

/**
 * Convert a raw BigQuery API response into a flat array of row objects.
 *
 * BQ responses look like:
 * {
 *   schema: { fields: [{name, type}, …] },
 *   rows:   [{ f: [{v: value}, …] }, …]
 * }
 */
function parseQueryResponse(data) {
  const cols = (data.schema?.fields || []).map(f => f.name);
  const rows = (data.rows || []).map(row =>
    Object.fromEntries(row.f.map((cell, i) => [cols[i], cell.v]))
  );
  return { cols, rows, totalRows: data.totalRows ?? String(rows.length) };
}

/** Promisified setTimeout helper */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ── DEMO DATA GENERATORS ────────────────────────────────────── */

/**
 * Generate synthetic source (Project A) data for demo mode.
 * Returns the same shape as parseQueryResponse().
 */
function genDemoSourceData() {
  const ids        = Array.from({ length: 16 }, (_, i) => 'TXN-' + String(1000 + i).padStart(4, '0'));
  const currencies = ['USD', 'EUR', 'GBP', 'INR'];
  const statuses   = ['SETTLED', 'PENDING', 'FAILED'];

  const rows = ids.map((id, i) => ({
    transaction_id: id,
    amount:         (Math.random() * 9900 + 100).toFixed(2),
    currency:       currencies[i % 4],
    status:         statuses[i % 3],
    created_at:     new Date(Date.now() - i * 86400000).toISOString().split('T')[0],
  }));

  return {
    cols:      ['transaction_id', 'amount', 'currency', 'status', 'created_at'],
    rows,
    totalRows: String(rows.length),
  };
}

// Cache so target amounts can be correlated with source amounts
let _cachedSourceDemo = null;
function getCachedSourceDemo() {
  if (!_cachedSourceDemo) _cachedSourceDemo = genDemoSourceData();
  return _cachedSourceDemo;
}

/**
 * Generate synthetic target (Project B) data for demo mode.
 * 13 IDs match source; 2 are target-only (unmatched).
 * Occasionally introduces a small variance in amount.
 */
function genDemoTargetData() {
  const src    = getCachedSourceDemo();
  const tgtIds = [...src.rows.slice(0, 13).map(r => r.transaction_id), 'TXN-9001', 'TXN-9002'];
  const currencies = ['USD', 'EUR', 'GBP', 'INR'];
  const statuses   = ['SETTLED', 'PENDING', 'FAILED'];

  const rows = tgtIds.map((id, i) => {
    const srcAmount = i < 13 ? parseFloat(src.rows[i].amount) : null;
    const amount    = srcAmount !== null
      ? (srcAmount + (Math.random() > 0.8 ? (Math.random() * 2 - 1).toFixed(2) * 1 : 0)).toFixed(2)
      : (Math.random() * 500 + 100).toFixed(2);
    return {
      txn_id:       id,
      txn_amount:   amount,
      ccy:          currencies[i % 4],
      status:       statuses[i % 3],
      booking_date: new Date(Date.now() - i * 86400000).toISOString().split('T')[0],
    };
  });

  return {
    cols:      ['txn_id', 'txn_amount', 'ccy', 'status', 'booking_date'],
    rows,
    totalRows: String(rows.length),
  };
}

/**
 * Generate a synthetic reconciliation result for demo mode,
 * correlating source and target demo datasets.
 */
function genDemoRecResult() {
  const src    = getCachedSourceDemo();
  const tgt    = genDemoTargetData();
  const tgtMap = Object.fromEntries(tgt.rows.map(r => [r.txn_id, r]));
  const rows   = [];

  // Source rows
  src.rows.forEach(sRow => {
    const tRow    = tgtMap[sRow.transaction_id];
    const srcAmt  = parseFloat(sRow.amount);
    const tgtAmt  = tRow ? parseFloat(tRow.txn_amount) : 0;
    const variance = (srcAmt - tgtAmt).toFixed(2);
    rows.push({
      match_key:  sRow.transaction_id,
      rec_status: tRow ? 'MATCHED' : 'SOURCE_ONLY',
      src_amount: srcAmt.toFixed(2),
      tgt_amount: tgtAmt.toFixed(2),
      variance,
      src_key:    sRow.transaction_id,
      tgt_key:    tRow ? sRow.transaction_id : null,
    });
  });

  // Target-only rows
  ['TXN-9001', 'TXN-9002'].forEach(id => {
    const tRow = tgtMap[id];
    rows.push({
      match_key:  id,
      rec_status: 'TARGET_ONLY',
      src_amount: '0.00',
      tgt_amount: tRow ? tRow.txn_amount : '320.00',
      variance:   tRow ? (0 - parseFloat(tRow.txn_amount)).toFixed(2) : '-320.00',
      src_key:    null,
      tgt_key:    id,
    });
  });

  return {
    cols:      ['match_key', 'rec_status', 'src_amount', 'tgt_amount', 'variance', 'src_key', 'tgt_key'],
    rows,
    totalRows: String(rows.length),
  };
}
