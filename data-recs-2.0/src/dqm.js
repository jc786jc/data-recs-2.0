/**
 * dqm.js — Data Quality Measurement logic
 * 5-step workflow: Configure → Query → PDEs & Grouping → Rules → Results
 */

/* ── GLOBAL STATE (required by auth.js) ─────────────────────────── */
const state = { token: null, user: null };

/* ── DQM STATE ───────────────────────────────────────────────────── */
const dqm = {
  cols:         [],   // [{name, type}] from INFORMATION_SCHEMA
  selectedPDEs: [],   // column names chosen as PDEs
  rules:        {},   // { colName: { completeness, conformity, specificity, reference } }
  groupCol:     '',
  results:      [],   // all result rows (across all PDEs)
  totalCount:   0,    // raw table row count
  evalCount:    0,    // rows after WHERE filters
};

/* ── NAVIGATION ──────────────────────────────────────────────────── */
function dqmGo(n) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`dqm-step-${n}`).classList.add('active');
  document.querySelectorAll('.step-item').forEach((el, i) => {
    el.classList.remove('active', 'done', 'disabled');
    if      (i + 1 === n) el.classList.add('active');
    else if (i + 1 <  n) el.classList.add('done');
    else                  el.classList.add('disabled');
  });
  if (n === 2) _autoFillSelectSQL();
  if (n === 4) renderRuleCards();
  if (n === 5) { dqm.results = []; renderDQMResults(); }
}

/* ── HELPERS ─────────────────────────────────────────────────────── */
function getVal(id) { return (document.getElementById(id)?.value || '').trim(); }
function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function showToast(msg, type = 'info') {
  const colors = { success:'var(--green)', error:'var(--accent3)', warn:'var(--yellow)', info:'var(--cyan)' };
  const t = Object.assign(document.createElement('div'), { textContent: msg });
  t.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;padding:12px 20px;
    border-radius:10px;font-size:13px;font-weight:600;color:#000;
    background:${colors[type]||colors.info};box-shadow:0 4px 24px rgba(0,0,0,.4);
    max-width:380px;animation:fadeIn .2s ease;`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}
function loaderHTML(msg) {
  return `<div style="display:flex;align-items:center;gap:12px;padding:20px;color:var(--text-muted);font-size:13px;">
    <div style="width:10px;height:10px;border-radius:50%;background:var(--cyan);animation:pulse 1.5s infinite;flex-shrink:0;"></div>
    ${escHtml(msg)}</div>`;
}
function pct(pass, total) {
  if (!total) return null;
  return Math.round(1000 * pass / total) / 10;
}
function pctCell(val) {
  if (val === null || val === undefined) return `<td style="color:var(--text-dim);">—</td>`;
  const color = val >= 95 ? 'var(--green)' : val >= 80 ? 'var(--yellow)' : 'var(--accent3)';
  return `<td style="color:${color};font-weight:700;">${val.toFixed(1)}%</td>`;
}

/* ── STEP 1: VALIDATE & TEST ─────────────────────────────────────── */
function validateDQMStep1() {
  const ok = ['dqm-project','dqm-dataset','dqm-table']
    .every(id => getVal(id) !== '');
  document.getElementById('btn-dqm-next1').disabled = !ok;
}

async function testDQMConnection() {
  const proj = getVal('dqm-project'), ds = getVal('dqm-dataset'),
        tbl  = getVal('dqm-table'),   loc = getVal('dqm-location');
  const result = document.getElementById('dqm-conn-result');
  if (!proj || !ds || !tbl) {
    result.innerHTML = `<span style="color:var(--yellow);">⚠️ Fill in Project, Dataset and Table first.</span>`;
    return;
  }
  result.innerHTML = `<span style="color:var(--text-muted);">Testing…</span>`;
  try {
    const res = await runBQQuery(proj,
      `SELECT COUNT(*) AS cnt FROM \`${proj}.${ds}.${tbl}\``,
      state.token, loc);
    const cnt = Number(res.rows[0]?.cnt || 0);
    if (cnt === 0) {
      result.innerHTML = `<span style="color:var(--yellow);">⚠️ Connected — <strong>${proj}.${ds}.${tbl}</strong> exists but has 0 rows.</span>`;
    } else {
      result.innerHTML = `<span style="color:var(--green);">✅ Connected — <strong>${proj}.${ds}.${tbl}</strong> | Rows: <strong>${cnt.toLocaleString()}</strong></span>`;
    }
  } catch (e) {
    result.innerHTML = `<span style="color:var(--accent3);">❌ ${escHtml(e.message)}</span>`;
  }
}

/* ── STEP 2: AUTO-FILL QUERY ─────────────────────────────────────── */
function _autoFillSelectSQL() {
  const proj = getVal('dqm-project'), ds = getVal('dqm-dataset'), tbl = getVal('dqm-table');
  const ta = document.getElementById('dqm-select-sql');
  if (ta && !ta.value.trim())
    ta.value = `SELECT *\nFROM \`${proj}.${ds}.${tbl}\``;
}

function toggleJoinSection() {
  const sec = document.getElementById('dqm-join-section');
  const btn = document.getElementById('btn-toggle-join');
  const show = sec.style.display === 'none';
  sec.style.display = show ? 'block' : 'none';
  btn.textContent   = show ? '− Remove JOIN' : '+ Add JOIN to Another Table';
}

/* ── STEP 3: LOAD COLUMNS & PDE SELECTION ────────────────────────── */
async function loadDQMColumns() {
  const proj = getVal('dqm-project'), ds = getVal('dqm-dataset'),
        tbl  = getVal('dqm-table'),   loc = getVal('dqm-location');
  const wrap = document.getElementById('dqm-col-list');
  wrap.innerHTML = loaderHTML('Loading columns…');
  try {
    const res = await runBQQuery(proj,
      `SELECT column_name, data_type FROM \`${proj}.${ds}.INFORMATION_SCHEMA.COLUMNS\`
       WHERE table_name = '${tbl}' ORDER BY ordinal_position`,
      state.token, loc);
    dqm.cols = res.rows.map(r => ({ name: r.column_name, type: r.data_type }));
    renderColList();
    _refreshGroupColDropdown();
    showToast(`${dqm.cols.length} columns loaded`, 'success');
  } catch (e) {
    wrap.innerHTML = `<div style="color:var(--accent3);font-size:12px;">❌ ${escHtml(e.message)}</div>`;
  }
}

function renderColList() {
  const wrap = document.getElementById('dqm-col-list');
  if (!dqm.cols.length) { wrap.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No columns loaded.</div>'; return; }
  wrap.innerHTML = dqm.cols.map(c => `
    <label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;
                  cursor:pointer;font-size:13px;border:1px solid transparent;
                  transition:background .15s;" class="col-row"
      onmouseover="this.style.background='var(--surface-2)'"
      onmouseout="this.style.background='transparent'">
      <input type="checkbox" value="${escHtml(c.name)}" onchange="updatePDESelection()"
        ${dqm.selectedPDEs.includes(c.name) ? 'checked' : ''}/>
      <span style="font-family:var(--mono);font-size:12px;color:var(--text);">${escHtml(c.name)}</span>
      <span style="margin-left:auto;font-size:10px;color:var(--text-dim);letter-spacing:0.5px;">${escHtml(c.type)}</span>
    </label>`).join('');
}

function selectAllCols() {
  document.querySelectorAll('#dqm-col-list input[type=checkbox]').forEach(cb => cb.checked = true);
  updatePDESelection();
}
function clearAllCols() {
  document.querySelectorAll('#dqm-col-list input[type=checkbox]').forEach(cb => cb.checked = false);
  updatePDESelection();
}

function updatePDESelection() {
  dqm.selectedPDEs = [...document.querySelectorAll('#dqm-col-list input[type=checkbox]:checked')]
    .map(cb => cb.value);
  document.getElementById('dqm-pde-count').textContent =
    dqm.selectedPDEs.length ? `${dqm.selectedPDEs.length} PDE${dqm.selectedPDEs.length>1?'s':''} selected` : 'None selected';
  document.getElementById('btn-dqm-next3').disabled = !dqm.selectedPDEs.length || !getVal('dqm-group-col');
}

function _refreshGroupColDropdown() {
  const sel = document.getElementById('dqm-group-col');
  if (!sel) return;
  sel.innerHTML = '<option value="">— select group-by column —</option>' +
    dqm.cols.map(c => `<option value="${escHtml(c.name)}">${escHtml(c.name)}</option>`).join('');
}

function onGroupColChange() {
  dqm.groupCol = getVal('dqm-group-col');
  document.getElementById('btn-dqm-next3').disabled = !dqm.selectedPDEs.length || !dqm.groupCol;
}

/* ── STEP 4: RULE CARDS ──────────────────────────────────────────── */
function renderRuleCards() {
  dqm.groupCol = getVal('dqm-group-col');
  const wrap = document.getElementById('dqm-rule-cards');
  if (!dqm.selectedPDEs.length) {
    wrap.innerHTML = `<div class="empty"><div class="icon">⚙️</div>No PDEs selected. Go back to Step 3.</div>`;
    return;
  }

  // Ensure rule objects exist for all selected PDEs
  dqm.selectedPDEs.forEach(pde => {
    if (!dqm.rules[pde]) {
      dqm.rules[pde] = {
        completeness: { condition: '' },
        conformity:   { enabled: false, expression: '' },
        specificity:  { enabled: false, values: '' },
        reference:    { enabled: false, table: '', column: '' },
      };
    }
  });

  wrap.innerHTML = dqm.selectedPDEs.map((pde, i) => {
    const r = dqm.rules[pde];
    const colType = dqm.cols.find(c => c.name === pde)?.type || '';
    return `
    <div class="card" style="margin-bottom:16px;border-color:rgba(0,229,255,0.15);">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
        <div style="width:28px;height:28px;border-radius:50%;background:var(--accent);color:#000;
                    font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          ${i + 1}
        </div>
        <div>
          <div style="font-size:14px;font-weight:700;color:var(--text);font-family:var(--mono);">${escHtml(pde)}</div>
          <div style="font-size:11px;color:var(--text-muted);">${escHtml(colType)}</div>
        </div>
      </div>

      <!-- Completeness -->
      <div style="padding:14px;background:var(--bg);border-radius:8px;border:1px solid var(--border);margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
          <div style="width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0;"></div>
          <span style="font-size:12px;font-weight:700;color:var(--green);">Completeness</span>
          <span style="font-size:11px;color:var(--text-muted);">— always applied · checks IS NOT NULL and IS NOT blank</span>
        </div>
        <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">
          Additional condition <span style="color:var(--text-dim)">(optional — AND'd with null check)</span>
        </label>
        <textarea rows="2" placeholder="e.g. TRIM(CAST(${escHtml(pde)} AS STRING)) != '0'"
          style="width:100%;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;
                 padding:8px 10px;color:var(--text);font-family:var(--mono);font-size:12px;resize:vertical;"
          oninput="dqm.rules['${escHtml(pde)}'].completeness.condition=this.value"
          >${escHtml(r.completeness.condition)}</textarea>
      </div>

      <!-- Conformity -->
      <div style="padding:14px;background:var(--bg);border-radius:8px;border:1px solid var(--border);margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:${r.conformity.enabled?'10px':'0'};">
          <input type="checkbox" id="conf-${escHtml(pde)}"
            ${r.conformity.enabled ? 'checked' : ''}
            onchange="dqm.rules['${escHtml(pde)}'].conformity.enabled=this.checked;
                      document.getElementById('conf-body-${escHtml(pde)}').style.display=this.checked?'block':'none'"/>
          <label for="conf-${escHtml(pde)}" style="font-size:12px;font-weight:700;color:var(--cyan);cursor:pointer;">
            Conformity
          </label>
          <span style="font-size:11px;color:var(--text-muted);">— applied on completeness pass records only</span>
        </div>
        <div id="conf-body-${escHtml(pde)}" style="display:${r.conformity.enabled?'block':'none'};">
          <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">
            SQL expression — returns TRUE when record passes
          </label>
          <textarea rows="3" placeholder="e.g. CAST(${escHtml(pde)} AS FLOAT64) > 0 AND CAST(${escHtml(pde)} AS FLOAT64) < 9999999"
            style="width:100%;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;
                   padding:8px 10px;color:var(--text);font-family:var(--mono);font-size:12px;resize:vertical;"
            oninput="dqm.rules['${escHtml(pde)}'].conformity.expression=this.value"
            >${escHtml(r.conformity.expression)}</textarea>
        </div>
      </div>

      <!-- Specificity -->
      <div style="padding:14px;background:var(--bg);border-radius:8px;border:1px solid var(--border);margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:${r.specificity.enabled?'10px':'0'};">
          <input type="checkbox" id="spec-${escHtml(pde)}"
            ${r.specificity.enabled ? 'checked' : ''}
            onchange="dqm.rules['${escHtml(pde)}'].specificity.enabled=this.checked;
                      document.getElementById('spec-body-${escHtml(pde)}').style.display=this.checked?'block':'none'"/>
          <label for="spec-${escHtml(pde)}" style="font-size:12px;font-weight:700;color:var(--yellow);cursor:pointer;">
            Specificity
          </label>
          <span style="font-size:11px;color:var(--text-muted);">— applied on conformity pass records only</span>
        </div>
        <div id="spec-body-${escHtml(pde)}" style="display:${r.specificity.enabled?'block':'none'};">
          <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">
            Exclude records where this column equals (comma-separated)
          </label>
          <input type="text" placeholder="e.g. 0, -1, N/A, UNKNOWN, NULL_VALUE"
            style="width:100%;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;
                   padding:8px 10px;color:var(--text);font-family:var(--mono);font-size:12px;"
            oninput="dqm.rules['${escHtml(pde)}'].specificity.values=this.value"
            value="${escHtml(r.specificity.values)}"/>
        </div>
      </div>

      <!-- Reference -->
      <div style="padding:14px;background:var(--bg);border-radius:8px;border:1px solid var(--border);">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:${r.reference.enabled?'10px':'0'};">
          <input type="checkbox" id="ref-${escHtml(pde)}"
            ${r.reference.enabled ? 'checked' : ''}
            onchange="dqm.rules['${escHtml(pde)}'].reference.enabled=this.checked;
                      document.getElementById('ref-body-${escHtml(pde)}').style.display=this.checked?'block':'none'"/>
          <label for="ref-${escHtml(pde)}" style="font-size:12px;font-weight:700;color:var(--accent2);cursor:pointer;">
            Reference Check
          </label>
          <span style="font-size:11px;color:var(--text-muted);">— validate against a static table in the same dataset</span>
        </div>
        <div id="ref-body-${escHtml(pde)}" style="display:${r.reference.enabled?'block':'none'};">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div>
              <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">Reference Table</label>
              <input type="text" placeholder="e.g. ref_currency_codes"
                style="width:100%;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;
                       padding:8px 10px;color:var(--text);font-family:var(--mono);font-size:12px;"
                oninput="dqm.rules['${escHtml(pde)}'].reference.table=this.value"
                value="${escHtml(r.reference.table)}"/>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">Reference Column</label>
              <input type="text" placeholder="e.g. currency_code"
                style="width:100%;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;
                       padding:8px 10px;color:var(--text);font-family:var(--mono);font-size:12px;"
                oninput="dqm.rules['${escHtml(pde)}'].reference.column=this.value"
                value="${escHtml(r.reference.column)}"/>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

/* ── SQL BUILDER ─────────────────────────────────────────────────── */
function buildPDESQL(pde) {
  const proj      = getVal('dqm-project');
  const ds        = getVal('dqm-dataset');
  const loc       = getVal('dqm-location');
  const selectSQL = document.getElementById('dqm-select-sql')?.value?.trim() || `SELECT * FROM \`${proj}.${ds}.${getVal('dqm-table')}\``;
  const whereSQL  = document.getElementById('dqm-where-sql')?.value?.trim();
  const joinType  = getVal('dqm-join-type') || 'LEFT JOIN';
  const joinTable = getVal('dqm-join-table');
  const joinOn    = document.getElementById('dqm-join-on')?.value?.trim();
  const joinWhere = document.getElementById('dqm-join-where')?.value?.trim();
  const groupCol  = dqm.groupCol;
  const r         = dqm.rules[pde] || {};
  const sysName   = getVal('dqm-system-name') || 'Tally DQM';
  const execDate  = getVal('dqm-exec-date') || new Date().toISOString().split('T')[0];

  // Build base SELECT (with optional join appended)
  let fullSelect = selectSQL;
  if (joinTable && joinOn) {
    fullSelect += `\n${joinType} \`${proj}.${ds}.${joinTable}\` ON ${joinOn}`;
    if (joinWhere) fullSelect += `\nAND (${joinWhere})`;
  }

  const baseWherePart = whereSQL ? `WHERE ${whereSQL}` : '';

  // Completeness condition
  const compNull  = `${pde} IS NOT NULL AND TRIM(CAST(${pde} AS STRING)) != ''`;
  const compExtra = (r.completeness?.condition || '').trim();
  const compWhere = compExtra ? `(${compNull}) AND (${compExtra})` : compNull;

  // Conformity
  const confExpr = r.conformity?.enabled && r.conformity?.expression?.trim()
    ? r.conformity.expression.trim() : null;

  // Specificity
  const specRaw = r.specificity?.enabled && r.specificity?.values?.trim()
    ? r.specificity.values.trim() : null;
  const specVals = specRaw
    ? specRaw.split(',').map(v => `'${v.trim().replace(/'/g, "\\'")}'`).join(', ') : null;

  // Reference
  const refEnabled = r.reference?.enabled && r.reference?.table && r.reference?.column;
  const refTable   = refEnabled ? `\`${proj}.${ds}.${r.reference.table}\`` : null;
  const refCol     = refEnabled ? r.reference.column : null;

  // Specificity WHERE in base (conformity pass AND specificity pass)
  const specWhere = [compWhere, confExpr ? `(${confExpr})` : null].filter(Boolean).join(' AND ');
  const refWhere  = [compWhere, confExpr ? `(${confExpr})` : null, specVals ? `TRIM(CAST(${pde} AS STRING)) NOT IN (${specVals})` : null].filter(Boolean).join(' AND ');

  let sql = `WITH base AS (\n  ${fullSelect.replace(/\n/g,'\n  ')}\n  ${baseWherePart}\n)`;

  // Completeness CTE
  sql += `,\ncomp AS (
  SELECT ${groupCol} AS grp, COUNT(*) AS evaluated,
    COUNTIF(${compWhere}) AS comp_pass,
    COUNT(*) - COUNTIF(${compWhere}) AS comp_fail
  FROM base GROUP BY ${groupCol}
)`;

  // Conformity CTE
  if (confExpr) {
    sql += `,\nconf AS (
  SELECT ${groupCol} AS grp,
    COUNTIF(${confExpr}) AS conf_pass,
    COUNT(*) - COUNTIF(${confExpr}) AS conf_fail
  FROM base WHERE ${compWhere} GROUP BY ${groupCol}
)`;
  }

  // Specificity CTE
  if (specVals) {
    sql += `,\nspec AS (
  SELECT ${groupCol} AS grp,
    COUNTIF(TRIM(CAST(${pde} AS STRING)) NOT IN (${specVals})) AS spec_pass,
    COUNTIF(TRIM(CAST(${pde} AS STRING)) IN (${specVals})) AS spec_fail
  FROM base WHERE ${specWhere} GROUP BY ${groupCol}
)`;
  }

  // Reference CTE
  if (refEnabled) {
    sql += `,\nref AS (
  SELECT b.${groupCol} AS grp,
    COUNTIF(r.${refCol} IS NOT NULL) AS ref_pass,
    COUNTIF(r.${refCol} IS NULL)     AS ref_fail
  FROM base b
  LEFT JOIN ${refTable} r ON TRIM(CAST(b.${pde} AS STRING)) = TRIM(CAST(r.${refCol} AS STRING))
  WHERE b.${refWhere} GROUP BY b.${groupCol}
)`;
  }

  // Final SELECT
  sql += `\nSELECT
  '${sysName.replace(/'/g,"\\'")}' AS system_name,
  '${execDate}'                    AS execution_date,
  comp.grp                         AS ${groupCol},
  '${pde}'                         AS pde,
  comp.evaluated,
  comp.comp_pass, comp.comp_fail,
  ROUND(100.0*comp.comp_pass/NULLIF(comp.evaluated,0),1) AS comp_pct`;

  if (confExpr)  sql += `,\n  conf.conf_pass, conf.conf_fail,\n  ROUND(100.0*conf.conf_pass/NULLIF(comp.comp_pass,0),1) AS conf_pct`;
  if (specVals)  sql += `,\n  spec.spec_pass, spec.spec_fail,\n  ROUND(100.0*spec.spec_pass/NULLIF(${confExpr?'conf.conf_pass':'comp.comp_pass'},0),1) AS spec_pct`;
  if (refEnabled) sql += `,\n  ref.ref_pass, ref.ref_fail,\n  ROUND(100.0*ref.ref_pass/NULLIF(ref.ref_pass+ref.ref_fail,0),1) AS ref_pct`;

  sql += `\nFROM comp`;
  if (confExpr)  sql += `\nLEFT JOIN conf USING (grp)`;
  if (specVals)  sql += `\nLEFT JOIN spec USING (grp)`;
  if (refEnabled) sql += `\nLEFT JOIN ref  USING (grp)`;
  sql += `\nORDER BY comp.grp`;

  return sql;
}

/* ── STEP 5: RUN ─────────────────────────────────────────────────── */
async function runDQM() {
  const proj = getVal('dqm-project'), ds = getVal('dqm-dataset'),
        tbl  = getVal('dqm-table'),   loc = getVal('dqm-location');
  const whereSQL = document.getElementById('dqm-where-sql')?.value?.trim();
  const selectSQL = document.getElementById('dqm-select-sql')?.value?.trim();
  const statusEl = document.getElementById('dqm-run-status');
  const btn = document.getElementById('btn-run-dqm');

  if (!dqm.selectedPDEs.length) { showToast('No PDEs selected.', 'warn'); return; }
  if (!dqm.groupCol) { showToast('No group-by column selected.', 'warn'); return; }

  btn.disabled = true; btn.textContent = '⏳ Running…';
  dqm.results = [];

  try {
    // 1. Total count (full table, no filters)
    statusEl.innerHTML = loaderHTML('Counting total records…');
    const totalRes = await runBQQuery(proj, `SELECT COUNT(*) AS cnt FROM \`${proj}.${ds}.${tbl}\``, state.token, loc);
    dqm.totalCount = Number(totalRes.rows[0]?.cnt || 0);

    // 2. Evaluated count (after WHERE filters)
    const evalSQL = whereSQL
      ? `SELECT COUNT(*) AS cnt FROM (${selectSQL}) WHERE ${whereSQL}`
      : `SELECT COUNT(*) AS cnt FROM (${selectSQL})`;
    const evalRes = await runBQQuery(proj, evalSQL, state.token, loc);
    dqm.evalCount = Number(evalRes.rows[0]?.cnt || 0);

    // 3. Run per-PDE checks
    for (let i = 0; i < dqm.selectedPDEs.length; i++) {
      const pde = dqm.selectedPDEs[i];
      statusEl.innerHTML = loaderHTML(`Running checks for PDE ${i+1}/${dqm.selectedPDEs.length}: ${pde}…`);
      const sql = buildPDESQL(pde);
      const res = await runBQQuery(proj, sql, state.token, loc);
      dqm.results.push(...res.rows);
    }

    statusEl.innerHTML = '';
    renderDQMResults();
    const jiraSection = document.getElementById('dqm-jira-section');
    if (jiraSection) jiraSection.style.display = 'block';
    updateJiraBellVisibility();

  } catch (e) {
    statusEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = '▶ Run DQM';
  }
}

/* ── STEP 5: RENDER RESULTS ──────────────────────────────────────── */
function renderDQMResults() {
  const wrap = document.getElementById('dqm-results-wrap');
  if (!dqm.results.length) {
    wrap.innerHTML = `<div class="empty"><div class="icon">📊</div>Click Run DQM to execute all checks.</div>`;
    return;
  }

  const filtered = dqm.totalCount - dqm.evalCount;
  const groupCol = dqm.groupCol;

  // Detect which rule columns exist across all results
  const hasCols = k => dqm.results.some(r => r[k] !== undefined && r[k] !== null);
  const hasConf = hasCols('conf_pct');
  const hasSpec = hasCols('spec_pct');
  const hasRef  = hasCols('ref_pct');

  // Which PDEs are missing optional rules (so we can show a hint)
  const missingRules = dqm.selectedPDEs.filter(pde => {
    const r = dqm.rules[pde] || {};
    return !r.conformity?.enabled && !r.specificity?.enabled && !r.reference?.enabled;
  });

  const ruleHintHtml = missingRules.length ? `
    <div class="alert alert-info" style="font-size:12px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:16px;">
      <div>
        ℹ️ <strong>${missingRules.length} PDE${missingRules.length>1?'s':''}</strong>
        (${missingRules.map(p => `<code>${escHtml(p)}</code>`).join(', ')})
        only have Completeness checked.
        Go back to Step 4 to enable Conformity, Specificity or Reference rules.
      </div>
      <button class="btn btn-sm btn-secondary" onclick="dqmGo(4)" style="white-space:nowrap;flex-shrink:0;">
        ← Step 4: Rules
      </button>
    </div>` : '';

  // Summary banner
  const summaryHtml = `
    <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px;">
      <div class="stat-card">
        <div class="stat-label">Total Records</div>
        <div class="stat-value">${dqm.totalCount.toLocaleString()}</div>
        <div class="stat-sub">in ${getVal('dqm-table')}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Evaluated</div>
        <div class="stat-value blue">${dqm.evalCount.toLocaleString()}</div>
        <div class="stat-sub">after WHERE filters applied</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Filtered Out</div>
        <div class="stat-value" style="color:var(--text-muted);">${filtered.toLocaleString()}</div>
        <div class="stat-sub">excluded by WHERE clause</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">PDEs Checked</div>
        <div class="stat-value">${dqm.selectedPDEs.length}</div>
        <div class="stat-sub">physical data elements</div>
      </div>
    </div>`;

  // Column header groups
  const headers = [
    { label: 'System',           span: 1 },
    { label: 'Exec Date',        span: 1 },
    { label: groupCol,           span: 1 },
    { label: 'PDE',              span: 1 },
    { label: 'Evaluated',        span: 1 },
    { label: '🟢 Completeness',  span: 3 },
    ...(hasConf ? [{ label: '🔵 Conformity',  span: 3 }] : []),
    ...(hasSpec ? [{ label: '🟡 Specificity', span: 3 }] : []),
    ...(hasRef  ? [{ label: '🟣 Reference',   span: 3 }] : []),
  ];

  const groupHdr = headers.map(h =>
    `<th colspan="${h.span}" style="text-align:center;border-bottom:2px solid var(--border);">${escHtml(h.label)}</th>`
  ).join('');

  const subHdr = [
    '<th>System</th>',
    '<th>Exec Date</th>',
    `<th>${escHtml(groupCol)}</th>`,
    '<th>PDE</th>',
    '<th>Evaluated</th>',
    '<th>Pass</th><th>Fail</th><th>Pass %</th>',
    ...(hasConf ? ['<th>Pass</th><th>Fail</th><th>Pass %</th>'] : []),
    ...(hasSpec ? ['<th>Pass</th><th>Fail</th><th>Pass %</th>'] : []),
    ...(hasRef  ? ['<th>Pass</th><th>Fail</th><th>Pass %</th>'] : []),
  ].join('');

  const rows = dqm.results.map(r => {
    const comp_pct = r.comp_pct != null ? Number(r.comp_pct) : null;
    const conf_pct = r.conf_pct != null ? Number(r.conf_pct) : null;
    const spec_pct = r.spec_pct != null ? Number(r.spec_pct) : null;
    const ref_pct  = r.ref_pct  != null ? Number(r.ref_pct)  : null;

    return `<tr>
      <td>${escHtml(r.system_name ?? '')}</td>
      <td>${escHtml(r.execution_date ?? '')}</td>
      <td><strong>${escHtml(r[groupCol] ?? r.grp ?? '')}</strong></td>
      <td style="font-family:var(--mono);color:var(--cyan);">${escHtml(r.pde ?? '')}</td>
      <td style="text-align:right;">${Number(r.evaluated || 0).toLocaleString()}</td>
      <td style="color:var(--green);text-align:right;">${Number(r.comp_pass || 0).toLocaleString()}</td>
      <td style="color:var(--accent3);text-align:right;">${Number(r.comp_fail || 0).toLocaleString()}</td>
      ${pctCell(comp_pct)}
      ${hasConf ? `
        <td style="color:var(--green);text-align:right;">${r.conf_pass != null ? Number(r.conf_pass).toLocaleString() : '—'}</td>
        <td style="color:var(--accent3);text-align:right;">${r.conf_fail != null ? Number(r.conf_fail).toLocaleString() : '—'}</td>
        ${pctCell(conf_pct)}` : ''}
      ${hasSpec ? `
        <td style="color:var(--green);text-align:right;">${r.spec_pass != null ? Number(r.spec_pass).toLocaleString() : '—'}</td>
        <td style="color:var(--accent3);text-align:right;">${r.spec_fail != null ? Number(r.spec_fail).toLocaleString() : '—'}</td>
        ${pctCell(spec_pct)}` : ''}
      ${hasRef ? `
        <td style="color:var(--green);text-align:right;">${r.ref_pass != null ? Number(r.ref_pass).toLocaleString() : '—'}</td>
        <td style="color:var(--accent3);text-align:right;">${r.ref_fail != null ? Number(r.ref_fail).toLocaleString() : '—'}</td>
        ${pctCell(ref_pct)}` : ''}
    </tr>`;
  }).join('');

  wrap.innerHTML = summaryHtml + ruleHintHtml + `
    <div style="overflow-x:auto;">
      <table class="data-table">
        <thead>
          <tr>${groupHdr}</tr>
          <tr style="background:var(--surface-2);">${subHdr}</tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:6px;padding:0 2px;">
      🟢 Completeness = null &amp; blank check + extra condition &nbsp;|&nbsp;
      🔵 Conformity = applied on completeness pass &nbsp;|&nbsp;
      🟡 Specificity = applied on conformity pass &nbsp;|&nbsp;
      🟣 Reference = lookup validation
    </div>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center;">
      <button class="btn btn-secondary btn-sm" onclick="exportDQMCSV()">⬇ Export CSV</button>
      <span style="font-size:11px;color:var(--text-muted);">${dqm.results.length} rows · ${dqm.selectedPDEs.length} PDEs · grouped by ${escHtml(groupCol)}</span>
    </div>`;
}

/* ── JIRA: DQM TICKET ────────────────────────────────────────────── */

async function createDQMJiraTicket() {
  if (!jiraState.domain) { openJiraConfig(); return; }

  const today  = new Date().toISOString().split('T')[0];
  const system = getVal('dqm-system-name') || 'DQM';
  const period = getVal('dqm-period') || today;
  const tbl    = getVal('dqm-table');
  const groupCol = dqm.groupCol;

  // Build per-PDE summary for ticket body
  const pdeLines = dqm.selectedPDEs.map(pde => {
    const rows = dqm.results.filter(r => r.pde === pde);
    if (!rows.length) return `${pde}: no results`;
    const totalEval = rows.reduce((s, r) => s + Number(r.evaluated || 0), 0);
    const totalPass = rows.reduce((s, r) => s + Number(r.comp_pass || 0), 0);
    const pct = totalEval > 0 ? ((totalPass / totalEval) * 100).toFixed(1) : '0.0';
    return `${pde}: ${totalPass.toLocaleString()}/${totalEval.toLocaleString()} completeness pass (${pct}%)`;
  });

  const btn = document.getElementById('btn-create-dqm-jira');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Creating…'; }

  const adfBody = {
    version: 1, type: 'doc',
    content: [
      heading(2, 'Data Quality Measurement Summary'),
      para(`DQM run completed on ${today}.`),
      para(`System: ${system} | Period: ${period} | Table: ${tbl}`),
      heading(3, 'Results Summary'),
      bulletList([
        `Total records in table: ${dqm.totalCount.toLocaleString()}`,
        `Evaluated records: ${dqm.evalCount.toLocaleString()}`,
        `Filtered out: ${(dqm.totalCount - dqm.evalCount).toLocaleString()}`,
        `PDEs checked: ${dqm.selectedPDEs.length}`,
        `Grouped by: ${groupCol}`,
      ]),
      heading(3, 'Per-PDE Completeness'),
      bulletList(pdeLines),
      heading(3, 'Action Required'),
      para('Please review the DQ exceptions. Reply to this ticket with explanations for any known issues or planned remediation actions. The Tally AI agent will read your response and provide recommendations.'),
    ],
  };

  try {
    const resp = await fetch(jiraProxyUrl('rest/api/3/issue'), {
      method: 'POST',
      headers: jiraProxyHeaders(jiraState.email, jiraState.apiToken, jiraState.domain),
      body: JSON.stringify({
        fields: {
          project:     { key: jiraState.projectKey },
          summary:     `[Tally DQM] ${system} — ${period} — ${dqm.selectedPDEs.length} PDEs checked`,
          issuetype:   { name: 'Task' },
          description: adfBody,
        },
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.errorMessages?.[0] || `HTTP ${resp.status}`);
    }

    const data = await resp.json();
    jiraState.activeTicket  = { key: data.key, id: data.id, url: `https://${jiraState.domain}/browse/${data.key}` };
    jiraState.lastCommentId = null;

    _renderDQMTicketCard(data.key);
    if (btn) btn.textContent = '✅ Ticket Created';
    showToast(`Jira ticket ${data.key} created.`, 'success');
    startJiraPolling();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '🎫 Create Jira Ticket'; }
    showToast('Failed to create Jira ticket: ' + e.message, 'error');
  }
}

function _renderDQMTicketCard(key) {
  const wrap = document.getElementById('dqm-ticket-wrap');
  if (!wrap) return;
  wrap.style.display = 'block';
  wrap.innerHTML = `
    <div style="padding:14px 18px;background:rgba(0,229,255,0.05);border:1px solid rgba(0,229,255,0.2);border-radius:10px;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">
        <div style="font-size:20px;">🎫</div>
        <div style="flex:1;">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:3px;">Active Jira Ticket</div>
          <a href="${jiraState.activeTicket.url}" target="_blank"
             style="color:var(--accent);font-weight:700;font-size:15px;">${escHtml(key)} ↗</a>
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">
            Polling every 60s for team responses
            <span id="jira-last-poll" style="margin-left:8px;"></span>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <div class="dot pulse" style="background:var(--green);"></div>
          <span style="font-size:11px;color:var(--green);">Live</span>
        </div>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <div style="font-size:12px;color:var(--text-muted);line-height:1.6;">
          When the team replies, click <strong style="color:var(--text);">Ask Agent</strong> —
          Claude will read the comments and assess the DQ issues.
        </div>
        <button id="btn-ask-agent" onclick="refreshAgent()"
          style="flex-shrink:0;display:flex;align-items:center;gap:7px;padding:8px 16px;
                 background:linear-gradient(135deg,rgba(179,136,255,0.15),rgba(0,229,255,0.1));
                 border:1px solid rgba(179,136,255,0.4);border-radius:8px;color:var(--text);
                 font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;">
          🤖 Ask Agent
        </button>
      </div>
      <div id="agent-result-wrap" style="display:none;margin-top:12px;"></div>
    </div>`;
}

/* ── CLAUDE AGENT (DQM) — overrides jira.js refreshAgent ─────────── */

async function refreshAgent() {
  if (!jiraState.activeTicket?.key) { showToast('No active Jira ticket.', 'warn'); return; }

  const btn  = document.getElementById('btn-ask-agent');
  const wrap = document.getElementById('agent-result-wrap');
  if (btn)  { btn.disabled = true; btn.textContent = '⏳ Reading comments…'; }
  if (wrap) wrap.style.display = 'none';

  try {
    const resp = await fetch(
      jiraProxyUrl(`rest/api/3/issue/${jiraState.activeTicket.key}/comment?orderBy=created`),
      { headers: jiraProxyHeaders(jiraState.email, jiraState.apiToken, jiraState.domain) }
    );
    if (!resp.ok) throw new Error(`Jira fetch failed: HTTP ${resp.status}`);

    const comments = (await resp.json()).comments || [];
    if (!comments.length) { showToast('No comments on this ticket yet.', 'info'); return; }

    const commentText = comments.map(c =>
      `[${new Date(c.created).toLocaleString()}] ${c.author?.displayName || 'Unknown'}:\n${extractADFText(c.body)}`
    ).join('\n\n');

    if (btn) btn.textContent = '🤖 Asking Claude…';

    const dqmSystemPrompt = `You are a Data Quality analysis agent for Tally, a financial data controls platform.

Read the Jira comments from the data team and analyse the data quality issues they are discussing.
The DQM checks cover: Completeness (null/blank checks), Conformity (format/rule checks), Specificity (excluded value checks), and Reference (lookup validation).

Respond ONLY with a valid JSON object — no markdown, no explanation outside the JSON.

Schema:
{
  "hasConcerns": true | false,
  "summary": "plain English summary of what the team is saying",
  "rootCauses": ["identified root causes of DQ failures"],
  "criticalPDEs": ["PDEs with most critical issues needing immediate attention"],
  "recommendations": ["specific remediation actions recommended"],
  "approvalRecommendation": "ACCEPT" | "INVESTIGATE" | "ESCALATE",
  "reasoning": "explanation of the recommendation"
}`;

    const agentResp = await fetch('http://localhost:9000/agent', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        comments:     commentText,
        matchKey:     'pde',
        systemPrompt: dqmSystemPrompt,
      }),
    });

    if (!agentResp.ok) {
      const err = await agentResp.json().catch(() => ({}));
      throw new Error(typeof err.error === 'string' ? err.error : err.error?.message || `HTTP ${agentResp.status}`);
    }

    renderAgentResult(await agentResp.json());

  } catch (e) {
    showToast('Agent error: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🤖 Ask Agent'; }
  }
}

/* ── CLAUDE AGENT RESULT (DQM) — overrides jira.js renderAgentResult */

function renderAgentResult(result) {
  const wrap = document.getElementById('agent-result-wrap');
  if (!wrap) return;
  wrap.style.display = 'block';

  const recColor = { ACCEPT:'var(--green)', INVESTIGATE:'var(--yellow)', ESCALATE:'var(--accent3)' }
    [result.approvalRecommendation] || 'var(--cyan)';

  const rootHtml = result.rootCauses?.length
    ? `<div style="margin-bottom:12px;">
         <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--accent3);margin-bottom:6px;">Root Causes</div>
         <ul style="margin:0;padding-left:16px;">
           ${result.rootCauses.map(c => `<li style="font-size:12px;color:var(--text);margin-bottom:4px;">${escHtml(c)}</li>`).join('')}
         </ul>
       </div>` : '';

  const critHtml = result.criticalPDEs?.length
    ? `<div style="margin-bottom:12px;">
         <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--yellow);margin-bottom:6px;">Critical PDEs</div>
         <div style="display:flex;flex-wrap:wrap;gap:6px;">
           ${result.criticalPDEs.map(p => `<span style="padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;font-family:var(--mono);background:rgba(255,214,0,0.1);color:var(--yellow);">${escHtml(p)}</span>`).join('')}
         </div>
       </div>` : '';

  const recoHtml = result.recommendations?.length
    ? `<div style="margin-bottom:12px;">
         <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px;">Recommendations</div>
         <ul style="margin:0;padding-left:16px;">
           ${result.recommendations.map(r => `<li style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">${escHtml(r)}</li>`).join('')}
         </ul>
       </div>` : '';

  wrap.innerHTML = `
    <div style="padding:18px 20px;background:rgba(179,136,255,0.06);border:1px solid rgba(179,136,255,0.3);border-radius:10px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:18px;">🤖</span>
          <span style="font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--accent2);">DQ Agent Analysis</span>
        </div>
        ${result.approvalRecommendation ? `
        <div style="padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;
                    background:${recColor}20;color:${recColor};">
          ${escHtml(result.approvalRecommendation)}
        </div>` : ''}
      </div>
      <p style="font-size:13px;color:var(--text);line-height:1.75;margin-bottom:14px;">${escHtml(result.summary || 'No summary available.')}</p>
      ${rootHtml}${critHtml}${recoHtml}
      ${result.reasoning ? `<div style="font-size:11px;color:var(--text-muted);border-top:1px solid var(--border);padding-top:10px;margin-top:10px;line-height:1.7;">${escHtml(result.reasoning)}</div>` : ''}
      <div style="margin-top:12px;">
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('agent-result-wrap').style.display='none'">Dismiss</button>
      </div>
    </div>`;
}

/* ── EXPORT ──────────────────────────────────────────────────────── */
function exportDQMCSV() {
  if (!dqm.results.length) { showToast('No results to export.', 'warn'); return; }
  const keys = Object.keys(dqm.results[0]);
  const rows = [keys.join(','), ...dqm.results.map(r =>
    keys.map(k => `"${String(r[k]??'').replace(/"/g,'""')}"`).join(',')
  )].join('\n');
  const blob = new Blob([rows], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url, download: `dqm_results_${new Date().toISOString().split('T')[0]}.csv`
  });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('CSV exported.', 'success');
}
