/**
 * app.js — Data Recs 2.0 Application Logic
 *
 * Handles:
 *  • Step navigation
 *  • Form validation
 *  • Triggering BQ queries (via bigquery.js)
 *  • Building the cross-project reconciliation SQL
 *  • Rendering result tables
 *  • Building the summary report
 *  • CSV export
 */

/* ── GLOBAL STATE ────────────────────────────────────────────── */
const state = {
  token:        null,   // OAuth Bearer token (set by auth.js)
  user:         null,   // Google user profile
  srcRows:      null,   // Source query result rows
  srcCols:      null,   // Source query column names
  tgtRows:      null,   // Target query result rows
  tgtCols:      null,   // Target query column names
  recRows:      null,   // Reconciliation result rows
  recCols:      null,   // Reconciliation result column names
  matchedRows:    null,   // Privacy mode: matched_keys rows
  matchedCols:    null,
  unmatchedRows:  null,  // Privacy mode: unmatched_keys rows
  unmatchedCols:  null,
  matchedCount:   0,     // Actual row counts from Project C
  unmatchedCount: 0,
  srcOnlyCount:   0,
  tgtOnlyCount:   0,
  srcCount:       0,
  tgtCount:       0,
  currentStep:    1,
  currentRunId:   null,  // ID of the active history run
  csvMode:        false, // true when CSV files are used instead of BigQuery
  contentMapping: [],    // content column pairs used in last run
  contentSummary: null,  // { total, per-column match/mismatch } from last run
};

/* ── NAVIGATION ──────────────────────────────────────────────── */

/**
 * Activate a step panel and update the progress tabs.
 * @param {number} n — Step number 1–5
 */
function goStep(n) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('step-' + n).classList.add('active');

  document.querySelectorAll('.step-item').forEach((el, i) => {
    el.classList.remove('active', 'done', 'disabled');
    if (i + 1 === n)      el.classList.add('active');
    else if (i + 1 < n)   el.classList.add('done');
    else                   el.classList.add('disabled');
  });

  state.currentStep = n;

  if (n === 2 || n === 3) { updateQueryHints(); updateHashPreviews(); }
  if (n === 4)             { autoFillJoinKeys(); buildRecQuery(); }
  if (n === 5)             buildWriteBackPreview();
}

/* ── STEP 1 — DATA SOURCE MODE ───────────────────────────────── */

function setStep1Mode(mode) {
  const isCSV = mode === 'csv';
  const csvBtn = document.getElementById('mode-btn-csv');
  const bqBtn  = document.getElementById('mode-btn-bq');
  const csvSec = document.getElementById('step1-csv-section');
  const bqSec  = document.getElementById('step1-bq-section');

  if (csvBtn) csvBtn.className = isCSV ? 'btn btn-primary'   : 'btn btn-secondary';
  if (bqBtn)  bqBtn.className  = isCSV ? 'btn btn-secondary' : 'btn btn-primary';
  if (csvSec) csvSec.style.display = isCSV ? 'block' : 'none';
  if (bqSec)  bqSec.style.display  = isCSV ? 'none'  : 'block';

  state.csvMode = isCSV;

  if (isCSV) {
    // Initialise upload widgets if not already done
    if (!document.getElementById('src-csv-upload-step1-dz')) {
      renderCSVUpload('src-csv-upload-step1', (result) => {
        state.srcRows = result.rows;
        state.srcCols = result.cols;
        _populateMatchKeyFromCSV('src', result.cols);
        _checkCSVStep1Ready();
      }, 'Drop Source CSV file here');
    }
    if (!document.getElementById('tgt-csv-upload-step1-dz')) {
      renderCSVUpload('tgt-csv-upload-step1', (result) => {
        state.tgtRows = result.rows;
        state.tgtCols = result.cols;
        _populateMatchKeyFromCSV('tgt', result.cols);
        _checkCSVStep1Ready();
      }, 'Drop Target CSV file here');
    }
    _checkCSVStep1Ready();
  } else {
    state.srcRows = null;
    state.tgtRows = null;
    validateStep1();
  }
}

function _checkCSVStep1Ready() {
  const status = document.getElementById('csv-step1-status');
  const btn    = document.getElementById('btn-step1-next');
  const srcOk  = state.srcRows && state.srcRows.length > 0;
  const tgtOk  = state.tgtRows && state.tgtRows.length > 0;

  if (srcOk && tgtOk) {
    if (status) status.innerHTML = `<div class="alert" style="border-color:var(--green);color:var(--green);font-size:12px;">✅ Both CSV files loaded — click Next to select match key columns.</div>`;
    if (btn) btn.disabled = false;
  } else {
    const missing = [!srcOk && 'Source', !tgtOk && 'Target'].filter(Boolean).join(' and ');
    if (status) status.innerHTML = `<div style="font-size:12px;color:var(--text-muted);">Upload ${missing} CSV to continue.</div>`;
    if (btn) btn.disabled = true;
  }
}

/* ── STEP 1 — PROJECT CONFIGURATION ─────────────────────────── */

/**
 * Called when source/target system type dropdown changes.
 * Shows/hides BigQuery vs Starburst-specific fields and re-validates.
 */
function onTypeChange(which) {
  const isA  = which === 'src';
  const type = getVal(isA ? 'proj-a-type' : 'proj-b-type');
  const pfx  = isA ? 'proj-a' : 'proj-b';

  const sbFields  = document.getElementById(`${pfx}-sb-fields`);
  const bqFields  = document.getElementById(`${pfx}-bq-fields`);
  const locField  = document.getElementById(`${pfx}-loc-field`);

  const isSB = type === 'starburst';
  if (sbFields) sbFields.style.display = isSB ? 'block' : 'none';
  if (bqFields) bqFields.style.display = isSB ? 'none'  : 'block';
  if (locField) locField.style.display = isSB ? 'none'  : 'block';

  validateStep1();
  updateHashPreviews();
}

/** Enable/disable the "Next" button based on required fields per system type. */
function validateStep1() {
  const srcType = getVal('proj-a-type');
  const tgtType = getVal('proj-b-type');

  const srcRequired = srcType === 'starburst'
    ? ['proj-a-sb-host', 'proj-a-sb-catalog', 'proj-a-dataset', 'proj-a-table']
    : ['proj-a-id', 'proj-a-dataset', 'proj-a-table'];

  const tgtRequired = tgtType === 'starburst'
    ? ['proj-b-sb-host', 'proj-b-sb-catalog', 'proj-b-dataset', 'proj-b-table']
    : ['proj-b-id', 'proj-b-dataset', 'proj-b-table'];

  const required = [...srcRequired, ...tgtRequired, 'proj-c-id', 'proj-c-dataset'];
  const allFilled = required.every(id => getVal(id) !== '');
  document.getElementById('btn-step1-next').disabled = !allFilled;
}

/* ── STEP 2 & 3 — QUERY HINTS ────────────────────────────────── */

/**
 * Populate project labels, BQ table references, and auto-fill
 * query textareas when the user first reaches steps 2 or 3.
 */
function updateQueryHints() {
  const aId  = getVal('proj-a-id'),  aDs = getVal('proj-a-dataset'), aT = getVal('proj-a-table');
  const bId  = getVal('proj-b-id'),  bDs = getVal('proj-b-dataset'), bT = getVal('proj-b-table');
  const aRef = `\`${aId}.${aDs}.${aT}\``;
  const bRef = `\`${bId}.${bDs}.${bT}\``;

  setText('src-proj-label', aId);
  setText('tgt-proj-label', bId);
  setText('src-bq-ref',     aRef);
  setText('tgt-bq-ref',     bRef);

  setAttr('src-billing-proj', 'placeholder', aId || 'Same as Project A');
  setAttr('tgt-billing-proj', 'placeholder', bId || 'Same as Project B');

  // Auto-fill only if the textarea is empty
  const srcTA = document.getElementById('src-query');
  const tgtTA = document.getElementById('tgt-query');
  if (srcTA && !srcTA.value.trim()) srcTA.value = `SELECT *\nFROM ${aRef}\nLIMIT 500`;
  if (tgtTA && !tgtTA.value.trim()) tgtTA.value = `SELECT *\nFROM ${bRef}\nLIMIT 500`;
}

/* ── HASH FIELD MANAGER ──────────────────────────────────────── */

// Stores available columns fetched from BigQuery for each side
const availableCols = { src: [], tgt: [] };
// Single match key column per side — hashed to hash_key, used for JOIN
const matchKey = { src: '', tgt: '' };
// Primary key hashing toggle (default ON for privacy)
const pkHashEnabled = { src: true, tgt: true };
// Content reconciliation columns { column: string, hash: boolean }
const contentCols = { src: [], tgt: [] };

/** Fetch column names from BigQuery INFORMATION_SCHEMA and populate dropdowns. */
async function fetchColumns(which) {
  const isA     = which === 'src';
  const projId  = getVal(isA ? 'proj-a-id' : 'proj-b-id');
  const dataset = getVal(isA ? 'proj-a-dataset' : 'proj-b-dataset');
  const table   = getVal(isA ? 'proj-a-table' : 'proj-b-table');
  const loc     = getVal(isA ? 'proj-a-location' : 'proj-b-location');

  if (!projId || !dataset || !table) {
    showToast('Fill in Project ID, Dataset and Table in Step 1 first.', 'warn');
    return;
  }

  const container = document.getElementById(`${which}-content-cols-list`);
  if (container) container.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:6px 0;">Loading columns…</div>`;

  try {
    const sql = `SELECT column_name, data_type
FROM \`${projId}.${dataset}.INFORMATION_SCHEMA.COLUMNS\`
WHERE table_name = '${table}'
ORDER BY ordinal_position`;

    const res = await runBQQuery(projId, sql, state.token, loc);
    availableCols[which] = res.rows.map(r => ({ name: r.column_name, type: r.data_type }));

    if (!availableCols[which].length) {
      container.innerHTML = `<div style="color:var(--accent3);font-size:12px;">No columns found. Check table name.</div>`;
      return;
    }

    // Populate the match key dropdown
    const matchKeySelect = document.getElementById(`${which}-match-key`);
    if (matchKeySelect) {
      matchKeySelect.innerHTML = availableCols[which]
        .map(c => `<option value="${escHtml(c.name)}" ${matchKey[which] === c.name ? 'selected' : ''}>${escHtml(c.name)} (${c.type})</option>`)
        .join('');
      // Default to first column if not yet set
      if (!matchKey[which]) {
        matchKey[which] = availableCols[which][0].name;
        matchKeySelect.value = matchKey[which];
      }
    }

    // Render any existing content column rows with fresh dropdowns
    renderContentCols(which);
    updateHashPreviews();
    showToast(`${availableCols[which].length} columns loaded for ${table}`, 'success');
  } catch (e) {
    container.innerHTML = `<div style="color:var(--accent3);font-size:12px;">❌ ${escHtml(e.message)}</div>`;
  }
}

/** Update the match key when the user changes the dropdown. */
function updateMatchKey(which, val) {
  matchKey[which] = val;
  updateHashPreviews();
}

/** Pre-fill Step 4 join key inputs from the selected match keys. */
function autoFillJoinKeys() {
  const srcEl = document.getElementById('join-key-src');
  const tgtEl = document.getElementById('join-key-tgt');
  if (srcEl && !srcEl.value && matchKey.src) srcEl.value = matchKey.src;
  if (tgtEl && !tgtEl.value && matchKey.tgt) tgtEl.value = matchKey.tgt;
}

/** Toggle primary key hashing on/off. */
function setPKHash(which, enabled) {
  pkHashEnabled[which] = enabled;
  updateHashPreviews();
}

/** Add a content reconciliation column. */
function addContentCol(which) {
  const cols = availableCols[which];
  const defaultCol = cols.length ? cols[0].name : '';
  contentCols[which].push({ column: defaultCol, hash: false });
  renderContentCols(which);
}

/** Remove a content column by index. */
function removeContentCol(which, idx) {
  contentCols[which].splice(idx, 1);
  renderContentCols(which);
}

/** Clear all content columns. */
function clearContentCols(which) {
  contentCols[which] = [];
  renderContentCols(which);
}

/** Update a field on a content column entry. */
function updateContentCol(which, idx, field, val) {
  if (contentCols[which][idx]) contentCols[which][idx][field] = val;
}

/** Re-render content column rows. */
function renderContentCols(which) {
  const container = document.getElementById(`${which}-content-cols-list`);
  if (!container) return;
  const cols  = availableCols[which];
  const pairs = contentCols[which];

  if (!pairs.length) {
    container.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:4px 0;">No columns added. Load Columns first, then click "+ Add Column".</div>`;
    return;
  }

  container.innerHTML = pairs.map((p, i) => `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:8px 10px;
                background:var(--bg);border:1px solid var(--border);border-radius:8px;">
      ${cols.length
        ? `<select onchange="updateContentCol('${which}',${i},'column',this.value)"
             style="flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text);font-size:13px;">
             ${cols.map(c => `<option value="${escHtml(c.name)}" ${p.column===c.name?'selected':''}>${escHtml(c.name)} (${c.type})</option>`).join('')}
           </select>`
        : `<input type="text" value="${escHtml(p.column)}"
             oninput="updateContentCol('${which}',${i},'column',this.value)"
             placeholder="column name"
             style="flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text);font-size:13px;"/>`
      }
      <label style="display:flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap;cursor:pointer;color:var(--text-muted);">
        <input type="checkbox" ${p.hash?'checked':''}
          onchange="updateContentCol('${which}',${i},'hash',this.checked)"/>
        Hash 🔒
      </label>
      <button onclick="removeContentCol('${which}',${i})"
        style="background:rgba(255,82,82,0.1);border:1px solid rgba(255,82,82,0.3);border-radius:6px;
               color:#ff5252;padding:5px 10px;cursor:pointer;font-size:12px;flex-shrink:0;">✕</button>
    </div>`).join('');
}

// Keep old names as aliases so existing HTML onclick attributes still work
const addHashField    = addContentCol;
const removeHashField = removeContentCol;
const clearHashFields = clearContentCols;
const renderHashFields = renderContentCols;
function updateHashField(which, idx, val) { updateContentCol(which, idx, 'column', val); }
function getPrimaryHashKey(which) { return contentCols[which][0]?.column || ''; }

/* ── PRIVACY HASHING ─────────────────────────────────────────── */

/**
 * Build the hash SQL expression for a given platform.
 * Accepts one or more columns; multiple columns are CONCAT'd with '|' separator.
 * Applies normalisation (TRIM, UPPER, LPAD) before hashing.
 *
 * @param {string}          platform   'bigquery' | 'oracle' | 'hive'
 * @param {string|string[]} cols       Column name(s) to hash
 * @param {string}          salt       Secret salt value
 * @param {boolean}         trim       Apply TRIM normalisation
 * @param {boolean}         upper      Apply UPPER normalisation
 * @param {boolean}         lpad       Apply LPAD normalisation
 * @param {string|number}   lpadWidth  Pad width when lpad is true
 */
function buildHashExpr(platform, cols, salt, trim, upper, lpad, lpadWidth) {
  if (!Array.isArray(cols)) cols = [cols];
  const colsList = cols.filter(Boolean);
  if (!colsList.length) colsList.push('your_key_col');

  const s = salt.replace(/'/g, "\\'");

  if (platform === 'bigquery') {
    const parts = colsList.map(col => {
      let expr = `CAST(${col} AS STRING)`;
      if (trim)  expr = `TRIM(${expr})`;
      if (upper) expr = `UPPER(${expr})`;
      if (lpad)  expr = `LPAD(${expr}, ${lpadWidth}, '0')`;
      return expr;
    });
    // Build CONCAT('salt', col1 [, '|', col2, ...])
    const concatArgs = [`'${s}'`];
    parts.forEach((p, i) => {
      concatArgs.push(p);
      if (i < parts.length - 1) concatArgs.push("'|'");
    });
    return `TO_HEX(SHA256(CONCAT(${concatArgs.join(', ')})))`;
  }

  if (platform === 'starburst') {
    const parts = colsList.map(col => {
      let expr = `CAST(${col} AS VARCHAR)`;
      if (trim)  expr = `TRIM(${expr})`;
      if (upper) expr = `UPPER(${expr})`;
      if (lpad)  expr = `LPAD(${expr}, ${lpadWidth}, '0')`;
      return expr;
    });
    const concatArgs = [`'${s}'`];
    parts.forEach((p, i) => {
      concatArgs.push(p);
      if (i < parts.length - 1) concatArgs.push("'|'");
    });
    return `lower(to_hex(sha256(to_utf8(concat(${concatArgs.join(', ')})))))`;
  }

  if (platform === 'oracle') {
    const parts = colsList.map(col => {
      let expr = `TO_CHAR(${col})`;
      if (trim)  expr = `TRIM(${expr})`;
      if (upper) expr = `UPPER(${expr})`;
      if (lpad)  expr = `LPAD(${expr}, ${lpadWidth}, '0')`;
      return expr;
    });
    const concatExpr = `'${s}' || ` + parts.join(" || '|' || ");
    return `LOWER(RAWTOHEX(DBMS_CRYPTO.HASH(UTL_RAW.CAST_TO_RAW(${concatExpr}), 4)))`;
  }

  if (platform === 'hive') {
    const parts = colsList.map(col => {
      let expr = `CAST(${col} AS STRING)`;
      if (trim)  expr = `trim(${expr})`;
      if (upper) expr = `upper(${expr})`;
      if (lpad)  expr = `lpad(${expr}, ${lpadWidth}, '0')`;
      return expr;
    });
    const concatArgs = [`'${s}'`];
    parts.forEach((p, i) => {
      concatArgs.push(p);
      if (i < parts.length - 1) concatArgs.push("'|'");
    });
    return `sha2(concat(${concatArgs.join(', ')}), 256)`;
  }

  return '';
}

/**
 * Generate the full hashed SELECT SQL for Oracle/Hive sources.
 * Used to show a copy-paste template for non-BigQuery systems.
 */
function buildPlatformHashSQL(which) {
  const isA      = which === 'src';
  const platform = getVal(isA ? 'proj-a-type' : 'proj-b-type');
  const dataset  = getVal(isA ? 'proj-a-dataset' : 'proj-b-dataset');
  const table    = getVal(isA ? 'proj-a-table'   : 'proj-b-table');
  const keyCol   = matchKey[which] || 'your_match_key_col';
  const extras   = contentCols[which].filter(p => p.hash).map(p => p.column).filter(Boolean);
  const salt     = getVal('secret-salt');
  const trim     = document.getElementById(isA ? 'src-norm-trim'  : 'tgt-norm-trim')?.checked;
  const upper    = document.getElementById(isA ? 'src-norm-upper' : 'tgt-norm-upper')?.checked;
  const lpad     = document.getElementById(isA ? 'src-norm-lpad'  : 'tgt-norm-lpad')?.checked;
  const lpadW    = getVal(isA ? 'src-lpad-width' : 'tgt-lpad-width') || '10';
  const matchHashExpr  = buildHashExpr(platform, [keyCol], salt, trim, upper, lpad, lpadW);
  const extraHashLines = extras.map(c =>
    `  ${buildHashExpr(platform, [c], salt, trim, upper, lpad, lpadW)} AS hash_${c},`
  ).join('\n');
  const target = isA ? 'source_hashed' : 'target_hashed';

  if (platform === 'starburst') {
    const catalog = getVal(isA ? 'proj-a-sb-catalog' : 'proj-b-sb-catalog') || 'your_catalog';
    return `-- Run this in Starburst, then load result into:\n-- project-c.${getVal('proj-c-dataset')}.${target}\nSELECT\n  ${matchHashExpr} AS hash_key,\n${extraHashLines}\n  amount  -- replace with your amount column\nFROM ${catalog}.${dataset}.${table || 'your_table'};`;
  }
  if (platform === 'oracle') {
    return `-- Run this on your Oracle system, then load result into:\n-- project-c.${getVal('proj-c-dataset')}.${target}\nSELECT\n  ${matchHashExpr} AS hash_key,\n${extraHashLines}\n  amount  -- replace with your amount column\nFROM ${dataset}.${table || 'your_table'};`;
  }
  if (platform === 'hive') {
    return `-- Run this on your Hive/Hadoop cluster, then load result into:\n-- project-c.${getVal('proj-c-dataset')}.${target}\nSELECT\n  ${matchHashExpr} AS hash_key,\n${extraHashLines}\n  amount  -- replace with your amount column\nFROM ${dataset}.${table || 'your_table'};`;
  }
  return '';
}

/** Update hash expression previews on Steps 2 & 3. */
function updateHashPreviews() {
  ['src', 'tgt'].forEach(which => {
    const isA      = which === 'src';
    const platform = getVal(isA ? 'proj-a-type' : 'proj-b-type');
    const hashOn   = pkHashEnabled[which];

    // Show/hide the entire preview section based on hash toggle
    const previewWrap = document.getElementById(`${which}-hash-preview-wrap`);
    if (previewWrap) previewWrap.style.display = hashOn ? 'block' : 'none';

    if (hashOn) {
      const keyCol = matchKey[which] || 'your_match_key_col';
      const salt   = getVal('secret-salt') ? '••••••' : '(no salt — enter one in Step 1 for privacy)';
      const trim   = document.getElementById(isA ? 'src-norm-trim'  : 'tgt-norm-trim')?.checked;
      const upper  = document.getElementById(isA ? 'src-norm-upper' : 'tgt-norm-upper')?.checked;
      const lpad   = document.getElementById(isA ? 'src-norm-lpad'  : 'tgt-norm-lpad')?.checked;
      const lpadW  = getVal(isA ? 'src-lpad-width' : 'tgt-lpad-width') || '10';
      const preview = document.getElementById(`${which}-hash-preview`);
      if (preview) preview.textContent = buildHashExpr(platform, [keyCol], salt, trim, upper, lpad, lpadW) || '—';
    }

    // Show/hide Oracle/Hive/Starburst template block
    const tmplBlock = document.getElementById(`${which}-oracle-template`);
    const tmplTA    = document.getElementById(`${which}-platform-sql`);
    if (tmplBlock && tmplTA) {
      if (platform !== 'bigquery') {
        tmplBlock.style.display = 'block';
        tmplTA.value = buildPlatformHashSQL(which);
      } else {
        tmplBlock.style.display = 'none';
      }
    }
  });
}

/** Insert a richer template query into a source or target editor. */
function insertTemplate(which) {
  const aId = getVal('proj-a-id'), aDs = getVal('proj-a-dataset'), aT = getVal('proj-a-table');
  const bId = getVal('proj-b-id'), bDs = getVal('proj-b-dataset'), bT = getVal('proj-b-table');

  const templates = {
    src: `SELECT\n  *\nFROM \`${aId}.${aDs}.${aT}\`\nWHERE DATE(created_at) = CURRENT_DATE()\nLIMIT 500`,
    tgt: `SELECT\n  *\nFROM \`${bId}.${bDs}.${bT}\`\nWHERE DATE(created_at) = CURRENT_DATE()\nLIMIT 500`,
  };
  const ta = document.getElementById(which === 'src' ? 'src-query' : 'tgt-query');
  if (ta) ta.value = templates[which];
}

/* ── TEST CONNECTION ─────────────────────────────────────────── */

async function testConnection(which) {
  const isA  = which === 'src';
  const type = getVal(isA ? 'proj-a-type' : 'proj-b-type');
  if (type === 'starburst') { await testStarburstConnection(which); return; }

  const projId  = getVal(isA ? 'proj-a-id' : 'proj-b-id');
  const dataset = getVal(isA ? 'proj-a-dataset' : 'proj-b-dataset');
  const table   = getVal(isA ? 'proj-a-table' : 'proj-b-table');
  const loc     = getVal(isA ? 'proj-a-location' : 'proj-b-location');
  const result  = document.getElementById(`${which}-conn-result`);

  if (!projId || !dataset || !table) {
    result.innerHTML = `<span style="color:var(--yellow);">⚠️ Fill in Project ID, Dataset and Table first.</span>`;
    return;
  }

  result.innerHTML = `<span style="color:var(--text-muted);">Testing connection…</span>`;

  try {
    const sql = `SELECT COUNT(*) AS cnt FROM \`${projId}.${dataset}.${table}\``;

    const res = await runBQQuery(projId, sql, state.token, loc);
    const cnt = Number(res.rows[0]?.cnt || 0);
    result.innerHTML = `<span style="color:var(--green);">✅ Connected — <strong>${projId}.${dataset}.${table}</strong> &nbsp;|&nbsp; Rows: <strong>${cnt.toLocaleString()}</strong></span>`;
  } catch (e) {
    result.innerHTML = `<span style="color:var(--accent3);">❌ ${escHtml(e.message)}</span>`;
  }
}

async function testStarburstConnection(which) {
  const isA     = which === 'src';
  const host    = getVal(isA ? 'proj-a-sb-host'    : 'proj-b-sb-host');
  const catalog = getVal(isA ? 'proj-a-sb-catalog'  : 'proj-b-sb-catalog');
  const schema  = getVal(isA ? 'proj-a-dataset'     : 'proj-b-dataset');
  const table   = getVal(isA ? 'proj-a-table'       : 'proj-b-table');
  const username = getVal(isA ? 'proj-a-sb-username' : 'proj-b-sb-username');
  const token   = getVal(isA ? 'proj-a-sb-token'    : 'proj-b-sb-token');
  const result  = document.getElementById(`${which}-conn-result`);

  if (!host || !catalog) {
    result.innerHTML = `<span style="color:var(--yellow);">⚠️ Fill in Starburst Host and Catalog first.</span>`;
    return;
  }

  result.innerHTML = `<span style="color:var(--text-muted);">Testing Starburst connection…</span>`;

  try {
    const resp = await fetch('http://localhost:9000/starburst-query', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        host, catalog, schema, username, token,
        sql: `SELECT COUNT(*) AS cnt FROM ${catalog}.${schema}.${table}`,
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const cnt  = data.rows?.[0]?.cnt ?? '?';
    result.innerHTML = `<span style="color:var(--green);">✅ Connected — <strong>${catalog}.${schema}.${table}</strong> &nbsp;|&nbsp; Rows: <strong>${Number(cnt).toLocaleString()}</strong></span>`;
  } catch (e) {
    result.innerHTML = `<span style="color:var(--accent3);">❌ ${escHtml(e.message)}</span>`;
  }
}

/* ── STEP 2 — SOURCE QUERY ───────────────────────────────────── */

async function runSourceQuery() {
  const projId   = getVal('proj-a-id');
  const location = getVal('proj-a-location');
  const sql      = document.getElementById('src-query').value.trim();

  if (!sql) { showToast('Please enter a SQL query.', 'warn'); return; }

  showQueryResult('src', null, true); // show loader

  try {
    const result = state.token === 'DEMO_TOKEN'
      ? await fakeDelay(genDemoSourceData, 1200)
      : await runBQQuery(projId, sql, state.token, location);

    state.srcRows = result.rows;
    state.srcCols = result.cols;
    showQueryResult('src', result);
  } catch (e) {
    showQueryResult('src', null, false, e.message);
  }
}

/* ── STEP 3 — TARGET QUERY ───────────────────────────────────── */

async function runTargetQuery() {
  const projId   = getVal('proj-b-id');
  const location = getVal('proj-b-location') || getVal('proj-a-location');
  const sql      = document.getElementById('tgt-query').value.trim();

  if (!sql) { showToast('Please enter a SQL query.', 'warn'); return; }

  showQueryResult('tgt', null, true);

  try {
    const result = state.token === 'DEMO_TOKEN'
      ? await fakeDelay(genDemoTargetData, 1400)
      : await runBQQuery(projId, sql, state.token, location);

    state.tgtRows = result.rows;
    state.tgtCols = result.cols;
    showQueryResult('tgt', result);
  } catch (e) {
    showQueryResult('tgt', null, false, e.message);
  }
}

/* ── STEP 4 — RECONCILIATION QUERY BUILDER ───────────────────── */

/**
 * Builds and inserts the cross-project reconciliation SQL
 * every time a join configuration field changes.
 */
function buildRecQuery() {
  const aId = getVal('proj-a-id'), aDs = getVal('proj-a-dataset'), aT = getVal('proj-a-table');
  const bId = getVal('proj-b-id'), bDs = getVal('proj-b-dataset'), bT = getVal('proj-b-table');

  const joinType = getVal('join-type') || 'FULL OUTER JOIN';
  const keySrc   = getVal('join-key-src') || 'id';
  const keyTgt   = getVal('join-key-tgt') || 'id';
  const amtCol   = getVal('amount-col');

  const amountClause = amtCol
    ? `\n  COALESCE(a.${amtCol}, 0)                   AS src_${amtCol},\n  COALESCE(b.${amtCol}, 0)                   AS tgt_${amtCol},\n  COALESCE(a.${amtCol}, 0)\n    - COALESCE(b.${amtCol}, 0)               AS variance,`
    : '';

  const sql =
`-- ──────────────────────────────────────────────────────────────
-- Data Recs 2.0  |  Cross-Project Reconciliation Query
-- Source : \`${aId}.${aDs}.${aT}\`
-- Target : \`${bId}.${bDs}.${bT}\`
-- Generated: ${new Date().toISOString()}
-- ──────────────────────────────────────────────────────────────

SELECT
  COALESCE(a.${keySrc}, b.${keyTgt})         AS match_key,
  CASE
    WHEN a.${keySrc} IS NOT NULL
     AND b.${keyTgt} IS NOT NULL             THEN 'MATCHED'
    WHEN a.${keySrc} IS NOT NULL             THEN 'SOURCE_ONLY'
    ELSE                                          'TARGET_ONLY'
  END                                        AS rec_status,${amountClause}
  a.${keySrc}                                AS src_key,
  b.${keyTgt}                                AS tgt_key

FROM \`${aId}.${aDs}.${aT}\`  a
${joinType}  \`${bId}.${bDs}.${bT}\`  b
  ON a.${keySrc} = b.${keyTgt}

ORDER BY rec_status, match_key;`;

  const ta = document.getElementById('rec-query');
  if (ta) ta.value = sql;
}

/** Copy the generated SQL to the clipboard. */
function copyRecQuery() {
  const sql = document.getElementById('rec-query')?.value;
  if (!sql) return;
  navigator.clipboard.writeText(sql)
    .then(() => showToast('Query copied to clipboard!', 'success'))
    .catch(() => showToast('Copy failed — try manually selecting the text.', 'warn'));
}

/* ── STEP 4 — RUN RECONCILIATION ─────────────────────────────── */

async function runReconciliation() {
  if (state.csvMode) { runCSVReconciliation(); return; }

  const projC    = getVal('proj-c-id');
  const dsC      = getVal('proj-c-dataset');
  const locC     = getVal('proj-c-location') || getVal('proj-a-location');
  const salt     = getVal('secret-salt');

  const wrap = document.getElementById('rec-result-wrap');
  const body = document.getElementById('rec-result-body');
  wrap.style.display = 'block';

  if (state.token === 'DEMO_TOKEN') {
    body.innerHTML = loaderHTML('Running demo reconciliation…');
    const result = await fakeDelay(genDemoRecResult, 1800);
    state.recRows = result.rows;
    state.recCols = result.cols;
    body.innerHTML = renderRecTable(result.cols, result.rows) + _qvdBtn();
    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  if (!projC || !dsC) {
    body.innerHTML = `<div class="alert alert-error">❌ Project C and dataset are required. Configure them in Step 1.</div>`;
    return;
  }

  const srcType      = getVal('proj-a-type');
  const tgtType      = getVal('proj-b-type');
  const srcMatchKey = matchKey.src;
  const tgtMatchKey = matchKey.tgt;

  if (!srcMatchKey || !tgtMatchKey) {
    body.innerHTML = `<div class="alert alert-error">❌ Match key column must be selected in Steps 2 and 3.</div>`;
    return;
  }

  // ── Helper: hash expression for primary key ──────────────────────────────
  const matchHashExpr = (which) => {
    const isA    = which === 'src';
    const plat   = getVal(isA ? 'proj-a-type' : 'proj-b-type');
    const keyCol = which === 'src' ? srcMatchKey : tgtMatchKey;
    const trim   = document.getElementById(isA ? 'src-norm-trim'  : 'tgt-norm-trim')?.checked;
    const upper  = document.getElementById(isA ? 'src-norm-upper' : 'tgt-norm-upper')?.checked;
    const lpad   = document.getElementById(isA ? 'src-norm-lpad'  : 'tgt-norm-lpad')?.checked;
    const lpadW  = getVal(isA ? 'src-lpad-width' : 'tgt-lpad-width') || '10';
    return buildHashExpr(plat, [keyCol], salt, trim, upper, lpad, lpadW);
  };

  // ── Helper: content column hash selects (only hashed content cols) ────────
  const contentHashSelects = (which) => {
    const isA    = which === 'src';
    const plat   = getVal(isA ? 'proj-a-type' : 'proj-b-type');
    const trim   = document.getElementById(isA ? 'src-norm-trim'  : 'tgt-norm-trim')?.checked;
    const upper  = document.getElementById(isA ? 'src-norm-upper' : 'tgt-norm-upper')?.checked;
    const lpad   = document.getElementById(isA ? 'src-norm-lpad'  : 'tgt-norm-lpad')?.checked;
    const lpadW  = getVal(isA ? 'src-lpad-width' : 'tgt-lpad-width') || '10';
    return contentCols[which].filter(p => p.hash && p.column).map(p =>
      `  ${buildHashExpr(plat, [p.column], salt, trim, upper, lpad, lpadW)} AS hash_${p.column}`
    ).join(',\n');
  };

  // ── Columns to EXCEPT from * (key + hashed content cols) ─────────────────
  const srcExcept = [srcMatchKey, ...contentCols.src.filter(p => p.hash).map(p => p.column)].filter(Boolean);
  const tgtExcept = [tgtMatchKey, ...contentCols.tgt.filter(p => p.hash).map(p => p.column)].filter(Boolean);

  try {
    // ── Step 1: Source → Project C ───────────────────────────────────────────
    if (srcType === 'bigquery') {
      const srcSQL    = document.getElementById('src-query').value.trim();
      const keyExpr   = pkHashEnabled.src ? `${matchHashExpr('src')} AS hash_key` : `${srcMatchKey} AS hash_key`;
      const extraSel  = contentHashSelects('src');
      const writeSourceSQL = `CREATE OR REPLACE TABLE \`${projC}.${dsC}.source_hashed\` AS
SELECT
  ${keyExpr},${extraSel ? '\n' + extraSel + ',' : ''}
  * EXCEPT(${srcExcept.join(', ')})
FROM (${srcSQL});`;
      body.innerHTML = loaderHTML('Step 1/4 — Writing source data to Project C…');
      await runBQQuery(projC, writeSourceSQL, state.token, locC);
    }

    // ── Step 2: Target → Project C ───────────────────────────────────────────
    if (tgtType === 'bigquery') {
      const tgtSQL    = document.getElementById('tgt-query').value.trim();
      const keyExpr   = pkHashEnabled.tgt ? `${matchHashExpr('tgt')} AS hash_key` : `${tgtMatchKey} AS hash_key`;
      const extraSel  = contentHashSelects('tgt');
      const writeTargetSQL = `CREATE OR REPLACE TABLE \`${projC}.${dsC}.target_hashed\` AS
SELECT
  ${keyExpr},${extraSel ? '\n' + extraSel + ',' : ''}
  * EXCEPT(${tgtExcept.join(', ')})
FROM (${tgtSQL});`;
      body.innerHTML = loaderHTML('Step 2/4 — Writing target data to Project C…');
      await runBQQuery(projC, writeTargetSQL, state.token, locC);
    }

    // ── Step 3: Matched keys ─────────────────────────────────────────────────
    const amtCol = getVal('amount-col');
    const amountClause = amtCol
      ? `,\n  COALESCE(s.${amtCol},0) AS src_amount,\n  COALESCE(t.${amtCol},0) AS tgt_amount,\n  COALESCE(s.${amtCol},0)-COALESCE(t.${amtCol},0) AS variance`
      : '';
    body.innerHTML = loaderHTML('Step 3/4 — Writing matched_keys to Project C…');
    await runBQQuery(projC,
      `CREATE OR REPLACE TABLE \`${projC}.${dsC}.matched_keys\` AS
SELECT s.hash_key${amountClause}
FROM \`${projC}.${dsC}.source_hashed\` s
INNER JOIN \`${projC}.${dsC}.target_hashed\` t ON s.hash_key = t.hash_key;`,
      state.token, locC);

    // ── Step 4: Unmatched keys ───────────────────────────────────────────────
    body.innerHTML = loaderHTML('Step 4/4 — Writing unmatched_keys to Project C…');
    await runBQQuery(projC,
      `CREATE OR REPLACE TABLE \`${projC}.${dsC}.unmatched_keys\` AS
SELECT hash_key, 'UNMATCHED' AS rec_status
FROM \`${projC}.${dsC}.source_hashed\`
WHERE hash_key NOT IN (SELECT hash_key FROM \`${projC}.${dsC}.target_hashed\`);`,
      state.token, locC);

    // ── Fetch volume counts ──────────────────────────────────────────────────
    body.innerHTML = loaderHTML('Fetching volume results…');
    const countResult = await runBQQuery(projC,
      `SELECT
         (SELECT COUNT(*) FROM \`${projC}.${dsC}.matched_keys\`)   AS matched,
         (SELECT COUNT(*) FROM \`${projC}.${dsC}.unmatched_keys\`) AS unmatched,
         (SELECT COUNT(*) FROM \`${projC}.${dsC}.source_hashed\`)  AS src_total,
         (SELECT COUNT(*) FROM \`${projC}.${dsC}.target_hashed\`)  AS tgt_total`,
      state.token, locC);

    const c = countResult.rows[0] || {};
    state.matchedCount   = Number(c.matched)   || 0;
    state.unmatchedCount = Number(c.unmatched) || 0;
    state.srcOnlyCount   = Number(c.unmatched) || 0;
    state.tgtOnlyCount   = 0;
    state.srcCount       = Number(c.src_total) || 0;
    state.tgtCount       = Number(c.tgt_total) || 0;

    // ── Volume results ───────────────────────────────────────────────────────
    body.innerHTML = `
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;
                  color:var(--text-muted);margin-bottom:10px;">── Volume Reconciliation</div>
      <div class="alert" style="border-color:var(--green);color:var(--green);margin-bottom:12px;">
        ✅ Volume reconciliation complete. Results written to <strong>${projC}.${dsC}</strong>
      </div>
      <div class="stats-grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:8px;">
        <div class="stat-card">
          <div class="stat-label">Matched Keys</div>
          <div class="stat-value green">${state.matchedCount.toLocaleString()}</div>
          <div class="stat-sub">${projC}.${dsC}.matched_keys</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Unmatched Keys</div>
          <div class="stat-value ${state.unmatchedCount > 0 ? 'red' : 'green'}">${state.unmatchedCount.toLocaleString()}</div>
          <div class="stat-sub">${projC}.${dsC}.unmatched_keys</div>
        </div>
      </div>
      ${_qvdBtn()}`;

    // ── Content reconciliation ───────────────────────────────────────────────
    const mapping = _buildContentMapping();
    const contentWrap = document.getElementById('content-rec-result-wrap');
    const contentBody = document.getElementById('content-rec-result-body');

    if (mapping.length > 0 && state.matchedCount > 0) {
      await _runContentRec(mapping, projC, dsC, locC);
    } else if (contentWrap && contentBody) {
      contentWrap.style.display = 'block';
      contentBody.innerHTML = mapping.length === 0
        ? `<div class="alert alert-info" style="font-size:12px;">
             ℹ️ No content columns configured — only volume reconciliation ran.
             To compare non-key columns, go back to
             <strong>Step 2</strong> and <strong>Step 3</strong>, click
             <strong>⟳ Load Columns</strong>, then <strong>+ Add Column</strong>
             to select the columns you want to compare on matched records.
           </div>`
        : `<div class="alert alert-info" style="font-size:12px;">
             ℹ️ Content reconciliation skipped — no matched records to compare.
           </div>`;
    }

    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  } catch (e) {
    body.innerHTML = `<div class="alert alert-error">❌ ${e.message}</div>`;
  }
}

/* ── CONTENT RECONCILIATION ──────────────────────────────────────── */

function _buildContentMapping() {
  const src = contentCols.src.filter(p => p.column);
  const tgt = contentCols.tgt.filter(p => p.column);
  const len = Math.min(src.length, tgt.length);
  return Array.from({ length: len }, (_, i) => ({
    srcCol: src[i].column,
    tgtCol: tgt[i].column,
    hashSrc: src[i].hash,
    hashTgt: tgt[i].hash,
    srcInC: src[i].hash ? `hash_${src[i].column}` : src[i].column,
    tgtInC: tgt[i].hash ? `hash_${tgt[i].column}` : tgt[i].column,
    label:  (src[i].column === tgt[i].column ? src[i].column : `${src[i].column}_vs_${tgt[i].column}`)
              .replace(/[^a-z0-9_]/gi, '_'),
    display: src[i].column === tgt[i].column ? src[i].column : `${src[i].column} → ${tgt[i].column}`,
  })).filter(m => m.srcCol && m.tgtCol);
}

async function _runContentRec(mapping, projC, dsC, locC) {
  const contentWrap = document.getElementById('content-rec-result-wrap');
  const contentBody = document.getElementById('content-rec-result-body');
  if (!contentWrap || !contentBody) return;

  contentWrap.style.display = 'block';
  contentBody.innerHTML = loaderHTML('Running content reconciliation on matched records…');

  try {
    // Build content comparison table in Project C
    const selects = mapping.map(m =>
      `  s.${m.srcInC} AS src_${m.label},\n` +
      `  t.${m.tgtInC} AS tgt_${m.label},\n` +
      `  CASE WHEN CAST(s.${m.srcInC} AS STRING) = CAST(t.${m.tgtInC} AS STRING) THEN 'MATCH' ELSE 'MISMATCH' END AS ${m.label}_status`
    ).join(',\n');

    await runBQQuery(projC,
      `CREATE OR REPLACE TABLE \`${projC}.${dsC}.content_comparison\` AS
SELECT s.hash_key,\n${selects}
FROM \`${projC}.${dsC}.source_hashed\` s
JOIN \`${projC}.${dsC}.target_hashed\` t ON s.hash_key = t.hash_key;`,
      state.token, locC);

    // Summary query
    const summarySelects = mapping.map(m =>
      `COUNTIF(${m.label}_status='MATCH') AS ${m.label}_match, COUNTIF(${m.label}_status='MISMATCH') AS ${m.label}_mismatch`
    ).join(', ');

    const summaryRes = await runBQQuery(projC,
      `SELECT COUNT(*) AS total, ${summarySelects} FROM \`${projC}.${dsC}.content_comparison\``,
      state.token, locC);

    _renderContentResults(mapping, summaryRes.rows[0] || {});
  } catch (e) {
    contentBody.innerHTML = `<div class="alert alert-error">❌ Content reconciliation failed: ${escHtml(e.message)}</div>`;
  }
}

function _renderContentResults(mapping, summary) {
  // Store in state so Step 6 summary can also display them
  state.contentMapping = mapping;
  state.contentSummary = summary;

  const contentBody = document.getElementById('content-rec-result-body');
  const total = Number(summary.total || 0);

  const rows = mapping.map(m => {
    const match = Number(summary[`${m.label}_match`]    || 0);
    const miss  = Number(summary[`${m.label}_mismatch`] || 0);
    const pct   = total > 0 ? (match / total * 100).toFixed(1) : '0.0';
    const color = Number(pct) >= 95 ? 'var(--green)' : Number(pct) >= 80 ? 'var(--yellow)' : 'var(--accent3)';
    const hashNote = (m.hashSrc || m.hashTgt) ? ' <span style="color:var(--text-dim);font-size:10px;">🔒 hashed</span>' : '';
    return `<tr>
      <td style="font-family:var(--mono);font-size:12px;">${escHtml(m.display)}${hashNote}</td>
      <td style="color:var(--green);text-align:right;">${match.toLocaleString()}</td>
      <td style="color:var(--accent3);text-align:right;">${miss.toLocaleString()}</td>
      <td style="color:${color};font-weight:700;text-align:right;">${pct}%</td>
    </tr>`;
  }).join('');

  contentBody.innerHTML = `
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px;line-height:1.7;">
      Comparing <strong style="color:var(--text);">${total.toLocaleString()}</strong> matched records across
      <strong style="color:var(--text);">${mapping.length}</strong> column pair${mapping.length !== 1 ? 's' : ''}.
      🔒 = value hashed before comparison (mismatch detected but actual value not visible in Project C).
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th>Column Pair</th>
          <th style="text-align:right;">Match</th>
          <th style="text-align:right;">Mismatch</th>
          <th style="text-align:right;">Match %</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/** Returns the Export QVD button HTML injected into reconciliation result panels. */
function _qvdBtn() {
  return `<div style="margin-top:16px;display:flex;align-items:center;gap:10px;">
    <button class="btn btn-secondary btn-sm" onclick="exportQVD()" title="Download reconciliation data as a QVD file for Qlik Sense / QlikView">
      📊 Export QVD for Qlik Sense
    </button>
    <span style="font-size:11px;color:var(--text-muted);">Open in Qlik Sense → Data Manager → Add Data → File</span>
  </div>`;
}

/* ── STEP 5 — WRITE EXCEPTIONS BACK TO PROJECT A ────────────── */

/** Build the write-back SQL and update the preview textarea. */
function buildWriteBackPreview() {
  const projA    = getVal('proj-a-id');
  const dsA      = getVal('proj-a-dataset');
  const tableA   = getVal('proj-a-table');
  const projC    = getVal('proj-c-id');
  const dsC      = getVal('proj-c-dataset');
  const keyCol   = matchKey.src;
  const salt     = getVal('secret-salt');
  const trim     = document.getElementById('src-norm-trim')?.checked;
  const upper    = document.getElementById('src-norm-upper')?.checked;
  const lpad     = document.getElementById('src-norm-lpad')?.checked;
  const lpadW    = getVal('src-lpad-width') || '10';

  // Update the destination label
  const destLabel = document.getElementById('exceptions-dest-label');
  if (destLabel) destLabel.textContent = `${projA}.${dsA}`;

  // Default table name: exceptions_YYYY_MM_DD
  const excTable = document.getElementById('exceptions-table');
  if (excTable && !excTable.value) {
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '_');
    excTable.value = `exceptions_${today}`;
  }
  const outTable   = excTable?.value || 'exceptions';
  const disposition = getVal('exceptions-disposition') || 'CREATE OR REPLACE';

  // Use the source SQL as the base (so filters/limits already applied)
  const srcSQL = document.getElementById('src-query')?.value?.trim()
    || `SELECT * FROM \`${projA}.${dsA}.${tableA}\``;

  const hashExpr = keyCol
    ? buildHashExpr('bigquery', [`orig.${keyCol}`], salt, trim, upper, lpad, lpadW)
    : 'TO_HEX(SHA256(CONCAT(\'(salt)\', orig.your_match_key)))';

  const sql =
`-- ── Write exceptions back to Project A ──────────────────────────
-- Joins original source data with unmatched_keys in Project C
-- using the same hash, then writes real records to Project A.
-- Project C never sees the plaintext key — only hashes are matched.

${disposition} TABLE \`${projA}.${dsA}.${outTable}\` AS
SELECT orig.*
FROM (
  ${srcSQL.replace(/\n/g, '\n  ')}
) orig
INNER JOIN \`${projC}.${dsC}.unmatched_keys\` u
  ON ${hashExpr} = u.hash_key;`;

  const ta = document.getElementById('writeback-query');
  if (ta) ta.value = sql;
}

/** Copy write-back SQL to clipboard. */
function copyWriteBackSQL() {
  const sql = document.getElementById('writeback-query')?.value;
  if (!sql) return;
  navigator.clipboard.writeText(sql)
    .then(() => showToast('SQL copied to clipboard!', 'success'))
    .catch(() => showToast('Copy failed — select the text manually.', 'warn'));
}

/** Execute the write-back query in Project A. */
async function runWriteBack() {
  const projA  = getVal('proj-a-id');
  const locA   = getVal('proj-a-location');
  const sql    = document.getElementById('writeback-query')?.value?.trim();
  const wrap   = document.getElementById('writeback-result-wrap');
  const body   = document.getElementById('writeback-result-body');

  if (!sql) {
    showToast('No SQL to run. Configure the exceptions table first.', 'warn');
    return;
  }
  if (!projA) {
    showToast('Project A ID is required.', 'warn');
    return;
  }

  wrap.style.display = 'block';
  body.innerHTML = loaderHTML('Writing exceptions to Project A…');

  try {
    await runBQQuery(projA, sql, state.token, locA);

    // Count how many rows were written
    const dsA    = getVal('proj-a-dataset');
    const outTable = getVal('exceptions-table') || 'exceptions';

    const countRes = await runBQQuery(projA,
      `SELECT COUNT(*) AS cnt FROM \`${projA}.${dsA}.${outTable}\``,
      state.token, locA);
    const cnt = Number(countRes.rows[0]?.cnt || 0);

    body.innerHTML = `
      <div class="alert" style="border-color:var(--green);color:var(--green);margin-bottom:12px;">
        ✅ Exceptions written successfully to <strong>${projA}.${dsA}.${outTable}</strong>
      </div>
      <div class="stats-grid" style="grid-template-columns:repeat(2,1fr);">
        <div class="stat-card">
          <div class="stat-label">Exception Records Written</div>
          <div class="stat-value red">${cnt.toLocaleString()}</div>
          <div class="stat-sub">${projA}.${dsA}.${outTable}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Source Records</div>
          <div class="stat-value blue">${state.srcCount.toLocaleString()}</div>
          <div class="stat-sub">${(state.srcCount > 0 ? ((cnt / state.srcCount) * 100).toFixed(1) : '0.0')}% exception rate</div>
        </div>
      </div>`;
    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    body.innerHTML = `<div class="alert alert-error">❌ ${escHtml(e.message)}</div>`;
  }
}

/* ── STEP 6 — SUMMARY REPORT ─────────────────────────────────── */

/** Generate unmask SQL for Project A or B to join real keys against Project C result tables. */
function buildUnmaskSQL(which) {
  const isA      = which === 'src';
  const platform = getVal(isA ? 'proj-a-type' : 'proj-b-type');
  const projId   = getVal(isA ? 'proj-a-id'   : 'proj-b-id');
  const dataset  = getVal(isA ? 'proj-a-dataset' : 'proj-b-dataset');
  const table    = getVal(isA ? 'proj-a-table'   : 'proj-b-table');
  const keyCol   = matchKey[which] || 'your_match_key_col';
  const salt     = getVal('secret-salt') ? '(your_salt)' : '(enter_salt)';
  const projC    = getVal('proj-c-id');
  const dsC      = getVal('proj-c-dataset');
  const trim     = document.getElementById(isA ? 'src-norm-trim'  : 'tgt-norm-trim')?.checked;
  const upper    = document.getElementById(isA ? 'src-norm-upper' : 'tgt-norm-upper')?.checked;
  const lpad     = document.getElementById(isA ? 'src-norm-lpad'  : 'tgt-norm-lpad')?.checked;
  const lpadW    = getVal(isA ? 'src-lpad-width' : 'tgt-lpad-width') || '10';
  const label    = isA ? 'A' : 'B';

  const hashExpr   = buildHashExpr(platform, [`orig.${keyCol}`], salt, trim, upper, lpad, lpadW);
  const keySelects = `  orig.${keyCol}`;

  if (platform === 'bigquery') {
    return `-- ── Unmask MATCHED records in Project ${label} ──\nSELECT\n${keySelects},\n  m.src_amount,\n  m.tgt_amount,\n  m.variance\nFROM \`${projId}.${dataset}.${table}\` orig\nJOIN \`${projC}.${dsC}.matched_keys\` m\n  ON ${hashExpr} = m.hash_key;\n\n-- ── Unmask UNMATCHED records in Project ${label} ──\nSELECT\n${keySelects},\n  u.rec_status\nFROM \`${projId}.${dataset}.${table}\` orig\nJOIN \`${projC}.${dsC}.unmatched_keys\` u\n  ON ${hashExpr} = u.hash_key;`;
  }
  if (platform === 'oracle') {
    return `-- ── Unmask MATCHED records in Project ${label} (Oracle) ──\nSELECT\n${keySelects},\n  m.src_amount,\n  m.tgt_amount,\n  m.variance\nFROM ${dataset}.${table} orig\nJOIN matched_keys_export m  -- load matched_keys from BQ first\n  ON ${hashExpr} = m.hash_key;\n\n-- ── Unmask UNMATCHED records in Project ${label} (Oracle) ──\nSELECT\n${keySelects},\n  u.rec_status\nFROM ${dataset}.${table} orig\nJOIN unmatched_keys_export u  -- load unmatched_keys from BQ first\n  ON ${hashExpr} = u.hash_key;`;
  }
  if (platform === 'hive') {
    return `-- ── Unmask MATCHED records in Project ${label} (Hive) ──\nSELECT\n${keySelects},\n  m.src_amount,\n  m.tgt_amount,\n  m.variance\nFROM ${dataset}.${table} orig\nJOIN matched_keys_export m  -- load matched_keys from BQ first\n  ON ${hashExpr} = m.hash_key;\n\n-- ── Unmask UNMATCHED records in Project ${label} (Hive) ──\nSELECT\n${keySelects},\n  u.rec_status\nFROM ${dataset}.${table} orig\nJOIN unmatched_keys_export u  -- load unmatched_keys from BQ first\n  ON ${hashExpr} = u.hash_key;`;
  }
  return '';
}

/** Builds the content reconciliation HTML block for Step 6 Summary. */
function _buildContentSummaryHTML() {
  const mapping = state.contentMapping || [];
  const summary = state.contentSummary;

  if (!mapping.length || !summary) {
    return `<div class="card" style="margin-top:20px;border-color:rgba(255,255,255,0.05);">
      <div class="card-title">📋 Content Reconciliation</div>
      <div class="alert alert-info" style="font-size:12px;margin:0;">
        ℹ️ Content reconciliation was not run. To compare non-key columns, go to
        <strong>Step 2</strong> and <strong>Step 3</strong>, click <strong>⟳ Load Columns</strong>,
        then <strong>+ Add Column</strong> to select columns — you must add columns in <strong>both</strong> steps.
      </div>
    </div>`;
  }

  const total = Number(summary.total || 0);
  const rows = mapping.map(m => {
    const match = Number(summary[`${m.label}_match`]    || 0);
    const miss  = Number(summary[`${m.label}_mismatch`] || 0);
    const pct   = total > 0 ? (match / total * 100).toFixed(1) : '0.0';
    const color = Number(pct) >= 95 ? 'var(--green)' : Number(pct) >= 80 ? 'var(--yellow)' : 'var(--accent3)';
    const hashNote = (m.hashSrc || m.hashTgt)
      ? `<span style="font-size:10px;color:var(--text-dim);margin-left:4px;">🔒 hashed</span>` : '';
    return `<tr>
      <td style="font-family:var(--mono);font-size:12px;">${escHtml(m.display)}${hashNote}</td>
      <td style="text-align:right;color:var(--green);">${match.toLocaleString()}</td>
      <td style="text-align:right;color:var(--accent3);">${miss.toLocaleString()}</td>
      <td style="text-align:right;font-weight:700;color:${color};">${pct}%</td>
    </tr>`;
  }).join('');

  return `<div class="card" style="margin-top:20px;border-color:rgba(0,229,255,0.15);">
    <div class="card-title">📋 Content Reconciliation — ${total.toLocaleString()} matched records compared</div>
    <table class="data-table">
      <thead>
        <tr>
          <th>Column Pair</th>
          <th style="text-align:right;">Match</th>
          <th style="text-align:right;">Mismatch</th>
          <th style="text-align:right;">Match %</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">
      🔒 = column hashed before comparison — mismatch detected but actual value not visible in Project C.
    </div>
  </div>`;
}

function buildSummary() {
  if (!state.matchedCount && !state.unmatchedCount) {
    document.getElementById('summary-body').innerHTML = `<div class="alert alert-error">❌ No reconciliation results found. Please run reconciliation first.</div>`;
    return;
  }

  const matched    = state.matchedCount;
  const unmatched  = state.unmatchedCount;
  const total      = state.srcCount;  // total compared = source records only
  const pct        = total > 0 ? ((matched / total) * 100).toFixed(1) : '0.0';
  const unmatchPct = total > 0 ? ((unmatched / total) * 100).toFixed(1) : '0.0';
  const srcId      = getVal('proj-a-id');
  const tgtId      = getVal('proj-b-id');

  document.getElementById('summary-body').innerHTML = `

    <!-- KPI CARDS ROW 1 — SOURCE / TARGET / TOTAL -->
    <div class="stats-grid" style="grid-template-columns:repeat(3,1fr);">
      <div class="stat-card">
        <div class="stat-label">Source Records</div>
        <div class="stat-value blue">${state.srcCount.toLocaleString()}</div>
        <div class="stat-sub">${escHtml(srcId)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Target Records</div>
        <div class="stat-value blue">${state.tgtCount.toLocaleString()}</div>
        <div class="stat-sub">${escHtml(tgtId)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Compared</div>
        <div class="stat-value blue">${total.toLocaleString()}</div>
        <div class="stat-sub">unique keys across both</div>
      </div>
    </div>

    <!-- KPI CARDS ROW 2 — MATCH / UNMATCH / PERCENTAGES -->
    <div class="stats-grid" style="grid-template-columns:repeat(4,1fr); margin-top:16px;">
      <div class="stat-card">
        <div class="stat-label">Matched Records</div>
        <div class="stat-value green">${matched.toLocaleString()}</div>
        <div class="stat-sub">found in target</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Unmatched Records</div>
        <div class="stat-value ${unmatched > 0 ? 'red' : 'green'}">${unmatched.toLocaleString()}</div>
        <div class="stat-sub">not found in target</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Match Rate</div>
        <div class="stat-value green">${pct}%</div>
        <div class="stat-sub">${matched.toLocaleString()} of ${total.toLocaleString()} source records</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Exception Rate</div>
        <div class="stat-value ${unmatched > 0 ? 'red' : 'green'}">${unmatchPct}%</div>
        <div class="stat-sub">${unmatched.toLocaleString()} exceptions</div>
      </div>
    </div>

    <!-- BREAKDOWN TABLE -->
    <div class="card" style="margin-top:20px;">
      <div class="card-title">Reconciliation Breakdown</div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Status</th><th>Count</th><th>% of Source</th><th>Action Required</th>
          </tr></thead>
          <tbody>
            <tr>
              <td><span class="match-badge matched">✓ MATCHED</span></td>
              <td>${matched.toLocaleString()}</td>
              <td>${pct}%</td>
              <td style="color:var(--text-dim)">None</td>
            </tr>
            <tr>
              <td><span class="match-badge left-only">✕ UNMATCHED</span></td>
              <td>${unmatched.toLocaleString()}</td>
              <td>${unmatchPct}%</td>
              <td style="color:var(--accent3)">Source records missing in Target — investigate</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- CONTENT RECONCILIATION SUMMARY -->
    ${_buildContentSummaryHTML()}

    <!-- ACTIONS -->
    <div class="card" style="margin-top:20px; border-color:var(--accent2);">
      <div class="card-title">🔓 Unmask Queries — Run Locally in Each System</div>
      <div class="alert alert-info" style="font-size:12px; margin-bottom:12px;">
        Project C only has hashed keys. Run these queries <strong>inside Project A and B</strong> to reveal real identifiers. The salt is never included in Project C.
      </div>
      <div class="form-group">
        <label>Project A — Unmask SQL (${getVal('proj-a-type').toUpperCase()})</label>
        <textarea class="code" style="min-height:120px;" spellcheck="false" readonly>${escHtml(buildUnmaskSQL('src'))}</textarea>
      </div>
      <div class="form-group" style="margin-top:16px;">
        <label>Project B — Unmask SQL (${getVal('proj-b-type').toUpperCase()})</label>
        <textarea class="code" style="min-height:120px;" spellcheck="false" readonly>${escHtml(buildUnmaskSQL('tgt'))}</textarea>
      </div>
      <div class="btn-row" style="margin-top:16px;">
        <button class="btn btn-secondary" onclick="exportCSV()">⬇ Export CSV</button>
        <button class="btn btn-secondary" onclick="resetApp()">↺ New Reconciliation</button>
      </div>
    </div>`;

  // Save run to history
  state.currentRunId = saveRunToHistory();

  // Show Jira ticket section once summary is rendered
  const jiraSection = document.getElementById('jira-step6-section');
  if (jiraSection) jiraSection.style.display = 'block';
}

/* ── RUN HISTORY ─────────────────────────────────────────────── */

function saveRunToHistory() {
  const id  = Date.now();
  const run = {
    id,
    date:           new Date().toISOString().split('T')[0],
    timestamp:      id,
    srcProject:     getVal('proj-a-id'),
    srcDataset:     getVal('proj-a-dataset'),
    srcTable:       getVal('proj-a-table'),
    srcDesc:        getVal('proj-a-desc') || '',
    tgtProject:     getVal('proj-b-id'),
    tgtDataset:     getVal('proj-b-dataset'),
    tgtTable:       getVal('proj-b-table'),
    tgtDesc:        getVal('proj-b-desc') || '',
    srcCount:       state.srcCount,
    tgtCount:       state.tgtCount,
    matchedCount:   state.matchedCount,
    unmatchedCount: state.unmatchedCount,
    matchRate:      state.srcCount > 0
                      ? ((state.matchedCount / state.srcCount) * 100).toFixed(1)
                      : '0.0',
    exceptionsTable: (() => {
      const t = document.getElementById('exceptions-table')?.value;
      const p = getVal('proj-a-id'); const d = getVal('proj-a-dataset');
      return t ? `${p}.${d}.${t}` : null;
    })(),
    jiraTicket: null,
  };

  const history = getRunHistory();
  history.unshift(run);
  if (history.length > 100) history.splice(100);
  localStorage.setItem('tally_run_history', JSON.stringify(history));
  return id;
}

function getRunHistory() {
  try { return JSON.parse(localStorage.getItem('tally_run_history') || '[]'); }
  catch (_) { return []; }
}

function updateRunHistoryTicket(runId, ticket) {
  const history = getRunHistory();
  const run     = history.find(r => r.id === runId);
  if (run) {
    run.jiraTicket = ticket;
    localStorage.setItem('tally_run_history', JSON.stringify(history));
  }
}

/* ── TABLE RENDERERS ─────────────────────────────────────────── */

/** Render a plain results table. */
function renderTable(cols, rows) {
  if (!rows?.length) return emptyHTML('No rows returned.');
  return `<div class="table-wrap"><table>
    <thead><tr>${cols.map(c => `<th>${escHtml(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r =>
      `<tr>${cols.map(c => `<td>${escHtml(r[c] ?? '')}</td>`).join('')}</tr>`
    ).join('')}</tbody>
  </table></div>`;
}

/** Render a reconciliation table with status badges and variance colouring. */
function renderRecTable(cols, rows) {
  if (!rows?.length) return emptyHTML('No rows returned.');
  return `<div class="table-wrap"><table>
    <thead><tr>${cols.map(c => `<th>${escHtml(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r =>
      `<tr>${cols.map(c => {
        if (c === 'rec_status') return `<td>${statusBadge(r[c])}</td>`;
        if (c === 'variance') {
          const v = parseFloat(r[c]) || 0;
          const clr = Math.abs(v) < 0.01 ? 'var(--green)' : 'var(--accent3)';
          return `<td style="color:${clr}">${escHtml(r[c] ?? '')}</td>`;
        }
        if (r[c] === null || r[c] === 'null') {
          return `<td style="color:var(--text-muted)">—</td>`;
        }
        return `<td>${escHtml(r[c] ?? '')}</td>`;
      }).join('')}</tr>`
    ).join('')}</tbody>
  </table></div>`;
}

/** Return the correct match-badge HTML for a rec_status value. */
function statusBadge(s) {
  const map = {
    'MATCHED':     '<span class="match-badge matched">✓ MATCHED</span>',
    'SOURCE_ONLY': '<span class="match-badge left-only">◀ SRC ONLY</span>',
    'TARGET_ONLY': '<span class="match-badge right-only">▶ TGT ONLY</span>',
  };
  return map[s] || escHtml(s || '');
}

/* ── RESULT DISPLAY HELPER ───────────────────────────────────── */

/**
 * Show loading state, error, or result table for a query panel.
 *
 * @param {'src'|'tgt'} which
 * @param {object|null} result
 * @param {boolean}     loading
 * @param {string}      errorMsg
 */
function showQueryResult(which, result, loading = false, errorMsg = null) {
  const wrap  = document.getElementById(`${which}-result-wrap`);
  const body  = document.getElementById(`${which}-result-body`);
  const title = document.getElementById(`${which}-result-title`);

  wrap.style.display = 'block';

  if (loading) {
    const proj = which === 'src' ? getVal('proj-a-id') : getVal('proj-b-id');
    body.innerHTML = loaderHTML(`Running query on ${proj || 'BigQuery'}…`);
    return;
  }
  if (errorMsg) {
    body.innerHTML = `<div class="alert alert-error">❌ ${escHtml(errorMsg)}</div>`;
    return;
  }

  const label = which === 'src' ? 'Source' : 'Target';
  title.textContent = `${label} Results — ${result.rows.length} rows / ${result.totalRows} total`;
  body.innerHTML = renderTable(result.cols, result.rows);
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ── CSV EXPORT ──────────────────────────────────────────────── */

function exportCSV() {
  if (!state.recRows || !state.recCols) return;
  const header = state.recCols.join(',');
  const body   = state.recRows
    .map(r => state.recCols.map(c => JSON.stringify(r[c] ?? '')).join(','))
    .join('\n');
  const blob = new Blob([header + '\n' + body], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `data-recs-${new Date().toISOString().split('T')[0]}.csv`,
  });
  a.click();
  URL.revokeObjectURL(url);
}

/* ── RESET ───────────────────────────────────────────────────── */

function resetApp() {
  state.srcRows = state.srcCols = null;
  state.tgtRows = state.tgtCols = null;
  state.recRows = state.recCols = null;
  state.matchedRows = state.matchedCols = null;
  state.unmatchedRows = state.unmatchedCols = null;
  state.matchedCount = state.unmatchedCount = 0;
  state.srcOnlyCount = state.tgtOnlyCount = 0;
  state.srcCount = state.tgtCount = 0;
  document.getElementById('rec-result-wrap').style.display = 'none';
  document.getElementById('src-query').value = '';
  document.getElementById('tgt-query').value = '';
  filters.src = [];
  filters.tgt = [];
  renderFilters('src');
  renderFilters('tgt');
  goStep(1);
}

/* ── UTILITIES ───────────────────────────────────────────────── */

/** Get trimmed value from an input/select by ID. */
function getVal(id) {
  return document.getElementById(id)?.value?.trim() ?? '';
}
/** Shorthand setter for input values. */
function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}
/** Set textContent of any element. */
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
/** Set an attribute on an element. */
function setAttr(id, attr, val) {
  const el = document.getElementById(id);
  if (el) el.setAttribute(attr, val);
}
/** Escape HTML special characters to prevent XSS in rendered tables. */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
/** Loader HTML snippet. */
function loaderHTML(msg) {
  return `<div class="loader"><div class="spinner"></div><span>${escHtml(msg)}</span></div>`;
}
/** Empty state HTML snippet. */
function emptyHTML(msg) {
  return `<div class="empty"><div class="icon">📭</div>${escHtml(msg)}</div>`;
}
/** Show a simple toast/alert. Extend with a proper toast lib if desired. */
function showToast(msg, type = 'info') {
  // Basic fallback — replace with a toast library for production
  const typeLabels = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' };
  console[type === 'error' ? 'error' : 'log'](`${typeLabels[type] || ''} ${msg}`);
  alert(msg);
}
/** Run a demo generator function after a simulated delay. */
async function fakeDelay(fn, ms) {
  await new Promise(r => setTimeout(r, ms));
  return fn();
}

/* ── FILTER BUILDER ──────────────────────────────────────────── */

// Each filter: { column, operator, value, type }
const filters = { src: [], tgt: [] };

const OPERATORS = {
  text:   ['=', '!=', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL'],
  number: ['=', '!=', '>', '>=', '<', '<=', 'BETWEEN', 'IS NULL', 'IS NOT NULL'],
  date:   ['=', '!=', '>', '>=', '<', '<=', 'BETWEEN', 'IS NULL', 'IS NOT NULL'],
};

/** Add a new blank filter row for src or tgt. */
function addFilter(which) {
  filters[which].push({ column: '', operator: '=', value: '', type: 'text' });
  renderFilters(which);
}

/** Remove a filter row by index. */
function removeFilter(which, idx) {
  filters[which].splice(idx, 1);
  renderFilters(which);
  applyFiltersToQuery(which);
}

/** Clear all filters. */
function clearFilters(which) {
  filters[which] = [];
  renderFilters(which);
  applyFiltersToQuery(which);
}

/** Re-render all filter rows into the DOM. */
function renderFilters(which) {
  const container = document.getElementById(`${which}-filters-list`);
  if (!container) return;

  if (!filters[which].length) {
    container.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:4px 0;">No filters added. Click "+ Add Filter" to filter the dataset.</div>`;
    return;
  }

  container.innerHTML = filters[which].map((f, i) => `
    <div style="display:grid; grid-template-columns:180px 140px 1fr auto; gap:10px; align-items:center; margin-bottom:8px;">
      <input type="text"
        class="filter-col-input"
        placeholder="Column name"
        value="${escHtml(f.column)}"
        oninput="updateFilter('${which}', ${i}, 'column', this.value)"
        style="background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text);font-size:12px;"/>

      <select
        onchange="updateFilter('${which}', ${i}, 'operator', this.value)"
        style="background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text);font-size:12px;">
        ${OPERATORS[f.type || 'text'].map(op =>
          `<option value="${op}" ${f.operator === op ? 'selected' : ''}>${op}</option>`
        ).join('')}
      </select>

      ${['IS NULL', 'IS NOT NULL'].includes(f.operator)
        ? `<span style="color:var(--text-muted);font-size:12px;padding:6px 0;">— no value needed</span>`
        : f.operator === 'BETWEEN'
          ? `<div style="display:flex;gap:6px;">
               <input type="text" placeholder="Start" value="${escHtml((f.value||'').split('|')[0]||'')}"
                 oninput="updateFilterBetween('${which}', ${i}, 'start', this.value)"
                 style="flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text);font-size:12px;"/>
               <input type="text" placeholder="End" value="${escHtml((f.value||'').split('|')[1]||'')}"
                 oninput="updateFilterBetween('${which}', ${i}, 'end', this.value)"
                 style="flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text);font-size:12px;"/>
             </div>`
          : `<input type="text"
               placeholder="${['IN','NOT IN'].includes(f.operator) ? "val1, val2, val3" : "Value"}"
               value="${escHtml(f.value || '')}"
               oninput="updateFilter('${which}', ${i}, 'value', this.value)"
               style="background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text);font-size:12px;"/>`
      }

      <button onclick="removeFilter('${which}', ${i})"
        style="background:rgba(255,82,82,0.1);border:1px solid rgba(255,82,82,0.3);border-radius:6px;color:#ff5252;padding:6px 10px;cursor:pointer;font-size:12px;">✕</button>
    </div>
  `).join('');
}

function updateFilter(which, idx, field, val) {
  filters[which][idx][field] = val;
  applyFiltersToQuery(which);
}

function updateFilterBetween(which, idx, part, val) {
  const parts = (filters[which][idx].value || '|').split('|');
  if (part === 'start') parts[0] = val;
  else parts[1] = val;
  filters[which][idx].value = parts.join('|');
  applyFiltersToQuery(which);
}

/** Build WHERE clause from filters and inject into the query textarea. */
function applyFiltersToQuery(which) {
  const ta = document.getElementById(`${which}-query`);
  if (!ta) return;

  const active = filters[which].filter(f => f.column.trim());
  if (!active.length) return;

  const clauses = active.map(f => {
    const col = f.column.trim();
    const op  = f.operator;
    const val = (f.value || '').trim();

    if (op === 'IS NULL')     return `${col} IS NULL`;
    if (op === 'IS NOT NULL') return `${col} IS NOT NULL`;
    if (op === 'BETWEEN') {
      const [start, end] = val.split('|');
      return `${col} BETWEEN '${start}' AND '${end}'`;
    }
    if (op === 'IN' || op === 'NOT IN') {
      const vals = val.split(',').map(v => `'${v.trim()}'`).join(', ');
      return `${col} ${op} (${vals})`;
    }
    if (op === 'LIKE' || op === 'NOT LIKE') return `${col} ${op} '${val}'`;
    // Numeric check — no quotes
    if (!isNaN(val) && val !== '') return `${col} ${op} ${val}`;
    // Date check
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return `${col} ${op} '${val}'`;
    return `${col} ${op} '${val}'`;
  });

  // Remove any existing WHERE clause and re-inject
  let sql = ta.value
    .replace(/\nWHERE[\s\S]*?((?=\nORDER BY|\nGROUP BY|\nLIMIT|\nHAVING)|$)/i, '')
    .replace(/\n-- \[Filters\][\s\S]*?((?=\n[A-Z])|$)/i, '')
    .trimEnd();

  sql += `\n-- [Filters]\nWHERE ${clauses.join('\n  AND ')}`;
  ta.value = sql;
}

/* ── INIT ────────────────────────────────────────────────────── */
buildRecQuery();
renderFilters('src');
renderFilters('tgt');
