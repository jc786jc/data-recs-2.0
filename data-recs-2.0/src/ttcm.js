/**
 * ttcm.js — Transaction Type Code Mapping (TTCM) logic
 * Reports 1–4 across ML15 (SSCRTYP) and ML16 (SSCRCEP).
 */

/* ── GLOBAL STATE (required by auth.js + jira.js) ───────────────── */
const state = { token: null, user: null };

/* ── TTCM STATE ──────────────────────────────────────────────────── */
let ttcmCSVMode = false;

const ttcm = {
  r1: { rows: null, cols: null, added: 0, deleted: 0 },
  r2: { rows: null, cols: null, changed: 0 },
  r3: { rows: null, cols: null, added: 0, deleted: 0 },
  r4: { rows: null, cols: null, changed: 0 },
};

/* ── NAVIGATION ──────────────────────────────────────────────────── */
function goTTCMStep(n) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('ttcm-step-' + n).classList.add('active');
  document.querySelectorAll('.step-item').forEach((el, i) => {
    el.classList.remove('active', 'done', 'disabled');
    if      (i + 1 === n) el.classList.add('active');
    else if (i + 1 <  n) el.classList.add('done');
    else                  el.classList.add('disabled');
  });
  if (n === 4) buildTTCMSummary();
}

/* ── STEP 1: VALIDATION ──────────────────────────────────────────── */
function validateTTCMStep1() {
  const ids = ['ttcm-project','ttcm-dataset','ttcm-ml15-prev','ttcm-ml15-cur','ttcm-ml16-prev','ttcm-ml16-cur'];
  const ok  = ids.every(id => (document.getElementById(id)?.value || '').trim() !== '');
  document.getElementById('btn-ttcm-next1').disabled = !ok;
}

async function testTTCMConnection() {
  const projId  = getVal('ttcm-project');
  const dataset = getVal('ttcm-dataset');
  const ml15p   = getVal('ttcm-ml15-prev');
  const loc     = getVal('ttcm-location');
  const result  = document.getElementById('ttcm-conn-result');

  if (!projId || !dataset || !ml15p) {
    result.innerHTML = `<span style="color:var(--yellow);">⚠️ Fill in Project ID, Dataset and at least the ML15 Prev table.</span>`;
    return;
  }
  result.innerHTML = `<span style="color:var(--text-muted);">Testing…</span>`;
  try {
    const sql = `SELECT table_id, row_count FROM \`${projId}.${dataset}.__TABLES__\` WHERE table_id = '${ml15p}'`;
    const res = await runBQQuery(projId, sql, state.token, loc);
    if (!res.rows.length) {
      result.innerHTML = `<span style="color:var(--accent3);">❌ Table <strong>${ml15p}</strong> not found in <strong>${dataset}</strong>.</span>`;
    } else {
      const cnt = Number(res.rows[0].row_count || 0).toLocaleString();
      result.innerHTML = `<span style="color:var(--green);">✅ Connected — <strong>${projId}.${dataset}</strong> accessible | ${ml15p}: <strong>${cnt} rows</strong></span>`;
    }
  } catch (e) {
    result.innerHTML = `<span style="color:var(--accent3);">❌ ${escHtml(e.message)}</span>`;
  }
}

/* ── HELPERS ─────────────────────────────────────────────────────── */
function ref(table) {
  const proj = getVal('ttcm-project');
  const ds   = getVal('ttcm-dataset');
  return `\`${proj}.${ds}.${table}\``;
}

function getVal(id) {
  return (document.getElementById(id)?.value || '').trim();
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg, type = 'info') {
  const t = document.createElement('div');
  const colors = { success:'var(--green)', error:'var(--accent3)', warn:'var(--yellow)', info:'var(--cyan)' };
  t.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;padding:12px 20px;border-radius:10px;font-size:13px;font-weight:600;color:#fff;background:${colors[type]||colors.info};box-shadow:0 4px 24px rgba(0,0,0,0.4);max-width:380px;animation:fadeIn .2s ease;`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

/* ── SQL BUILDERS ────────────────────────────────────────────────── */
function buildR1SQL() {
  const prev = ref(getVal('ttcm-ml15-prev'));
  const cur  = ref(getVal('ttcm-ml15-cur'));
  return `-- Report 1: New / Deleted Transaction Type Codes (ML15 SSCRTYP)
SELECT
  COALESCE(a.cyttyo, b.cyttyo)                    AS cyttyo,
  CASE WHEN a.cyttyo IS NULL THEN 'ADDED'
       ELSE 'DELETED' END                          AS change_type,
  a.cyttsn AS prev_cyttsn, b.cyttsn AS cur_cyttsn,
  a.cyttna AS prev_cyttna, b.cyttna AS cur_cyttna,
  a.cydcin AS prev_cydcin, b.cydcin AS cur_cydcin,
  a.cypraf AS prev_cypraf, b.cypraf AS cur_cypraf,
  a.cyatvt AS prev_cyatvt, b.cyatvt AS cur_cyatvt,
  COALESCE(b.people_soft_id, a.people_soft_id)    AS people_soft_id
FROM ${prev} a
FULL OUTER JOIN ${cur} b ON a.cyttyo = b.cyttyo
WHERE a.cyttyo IS NULL OR b.cyttyo IS NULL
ORDER BY change_type, COALESCE(a.cyttyo, b.cyttyo)`;
}

function buildR2SQL() {
  const prev = ref(getVal('ttcm-ml15-prev'));
  const cur  = ref(getVal('ttcm-ml15-cur'));
  return `-- Report 2: Changed Transaction Type Attributes (ML15 SSCRTYP)
SELECT
  a.cyttyo,
  a.cyttna AS prev_cyttna, b.cyttna AS cur_cyttna,
  a.cydcin AS prev_cydcin, b.cydcin AS cur_cydcin,
  a.cypraf AS prev_cypraf, b.cypraf AS cur_cypraf,
  a.cyatvt AS prev_cyatvt, b.cyatvt AS cur_cyatvt,
  b.people_soft_id AS changed_by
FROM ${prev} a
INNER JOIN ${cur} b ON a.cyttyo = b.cyttyo
WHERE a.cyttna  <> b.cyttna
   OR a.cydcin  <> b.cydcin
   OR a.cypraf  <> b.cypraf
   OR a.cyatvt  <> b.cyatvt
ORDER BY a.cyttyo`;
}

function buildR3SQL() {
  const prev = ref(getVal('ttcm-ml16-prev'));
  const cur  = ref(getVal('ttcm-ml16-cur'));
  return `-- Report 3: New / Deleted Mappings (ML16 SSCRCEP)
SELECT
  CASE WHEN a.cztcoe IS NULL THEN 'ADDED'
       ELSE 'DELETED' END                         AS change_type,
  COALESCE(a.cztcoe, b.cztcoe)                   AS cztcoe,
  COALESCE(a.cztcoz, b.cztcoz)                   AS cztcoz,
  COALESCE(a.czsscd, b.czsscd)                   AS czsscd,
  COALESCE(a.czdlcd, b.czdlcd)                   AS czdlcd,
  COALESCE(a.czimty, b.czimty)                   AS czimty,
  a.czttyo AS prev_czttyo, b.czttyo AS cur_czttyo,
  a.czatvt AS prev_czatvt, b.czatvt AS cur_czatvt,
  COALESCE(b.people_soft_id, a.people_soft_id)   AS people_soft_id
FROM ${prev} a
FULL OUTER JOIN ${cur} b
  ON TRIM(a.cztcoe)=TRIM(b.cztcoe) AND TRIM(a.cztcoz)=TRIM(b.cztcoz)
 AND TRIM(a.czsscd)=TRIM(b.czsscd) AND TRIM(a.czdlcd)=TRIM(b.czdlcd)
 AND TRIM(a.czimty)=TRIM(b.czimty)
WHERE (b.cztcoe IS NULL AND b.cztcoz IS NULL AND b.czsscd IS NULL AND b.czdlcd IS NULL AND b.czimty IS NULL)
   OR (a.cztcoe IS NULL AND a.cztcoz IS NULL AND a.czsscd IS NULL AND a.czdlcd IS NULL AND a.czimty IS NULL)
ORDER BY change_type, COALESCE(a.cztcoe, b.cztcoe)`;
}

function buildR4SQL() {
  const prev = ref(getVal('ttcm-ml16-prev'));
  const cur  = ref(getVal('ttcm-ml16-cur'));
  return `-- Report 4: Changed Mappings (ML16 SSCRCEP)
SELECT
  a.cztcoe, a.cztcoz, a.czsscd, a.czdlcd, a.czimty,
  a.cztmof AS prev_cztmof, b.cztmof AS cur_cztmof,
  a.czttyo AS prev_czttyo, b.czttyo AS cur_czttyo,
  a.czatvt AS prev_czatvt, b.czatvt AS cur_czatvt,
  b.people_soft_id AS changed_by
FROM ${prev} a
INNER JOIN ${cur} b
  ON TRIM(a.cztcoe)=TRIM(b.cztcoe) AND TRIM(a.cztcoz)=TRIM(b.cztcoz)
 AND TRIM(a.czsscd)=TRIM(b.czsscd) AND TRIM(a.czdlcd)=TRIM(b.czdlcd)
 AND TRIM(a.czimty)=TRIM(b.czimty)
WHERE TRIM(a.cztmof) <> TRIM(b.cztmof)
   OR TRIM(a.czttyo) <> TRIM(b.czttyo)
   OR TRIM(a.czatvt) <> TRIM(b.czatvt)
ORDER BY a.cztcoe, a.cztcoz, a.czsscd`;
}

/* ── RUN REPORTS ─────────────────────────────────────────────────── */
function toggleTTCMCSVSection() {
  const sec = document.getElementById('ttcm-csv-section');
  if (!sec) return;
  const showing = sec.style.display !== 'none';
  sec.style.display = showing ? 'none' : 'block';
  if (!showing) _initTTCMCSVUploads();
}

function _initTTCMCSVUploads() {
  const uploads = [
    { id: 'ttcm-csv-ml15prev', key: 'ml15prev', label: 'ML15 Previous Month CSV' },
    { id: 'ttcm-csv-ml15cur',  key: 'ml15cur',  label: 'ML15 Current Month CSV'  },
    { id: 'ttcm-csv-ml16prev', key: 'ml16prev',  label: 'ML16 Previous Month CSV' },
    { id: 'ttcm-csv-ml16cur',  key: 'ml16cur',   label: 'ML16 Current Month CSV'  },
  ];
  uploads.forEach(({ id, key, label }) => {
    if (document.getElementById(`${id}-dz`)) return; // already initialised
    renderCSVUpload(id, (result) => {
      ttcmCSV[key] = result.rows;
      ttcmCSVMode  = true;
      document.getElementById('btn-ttcm-next1').disabled = false;
      _updateTTCMCSVStatus();
    }, label);
  });
}

function _updateTTCMCSVStatus() {
  const el   = document.getElementById('ttcm-csv-status');
  if (!el) return;
  const keys = ['ml15prev','ml15cur','ml16prev','ml16cur'];
  const done = keys.filter(k => ttcmCSV[k]);
  if (done.length === 4) {
    el.innerHTML = `<div class="alert" style="border-color:var(--green);color:var(--green);font-size:12px;">✅ All 4 CSV files loaded — click Next to run reports in browser.</div>`;
  } else {
    el.innerHTML = `<div style="font-size:12px;color:var(--text-muted);">${done.length}/4 files uploaded</div>`;
  }
}

async function runReport(rpt) {
  if (ttcmCSVMode) { runCSVReport(rpt); return; }

  const projId  = getVal('ttcm-project');
  const loc     = getVal('ttcm-location');
  const bodyEl  = document.getElementById(`r${rpt}-body`);
  const sqlBuilders = { 1:buildR1SQL, 2:buildR2SQL, 3:buildR3SQL, 4:buildR4SQL };
  const sql = sqlBuilders[rpt]();

  bodyEl.innerHTML = loaderHTML(`Running Report ${rpt}…`);

  try {
    const res = await runBQQuery(projId, sql, state.token, loc);
    const store = ttcm[`r${rpt}`];
    store.rows = res.rows;
    store.cols = res.cols;

    if (rpt === 1 || rpt === 3) {
      store.added   = res.rows.filter(r => r.change_type === 'ADDED').length;
      store.deleted = res.rows.filter(r => r.change_type === 'DELETED').length;
    } else {
      store.changed = res.rows.length;
    }

    bodyEl.innerHTML = renderTTCMSummaryBar(rpt) + renderTTCMTable(rpt, res.cols, res.rows);
  } catch (e) {
    bodyEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(e.message)}</div>`;
  }
}

function loaderHTML(msg) {
  return `<div style="display:flex;align-items:center;gap:12px;padding:20px;color:var(--text-muted);font-size:13px;">
    <div class="dot pulse" style="background:var(--cyan);width:10px;height:10px;border-radius:50%;flex-shrink:0;"></div>${escHtml(msg)}
  </div>`;
}

/* ── RESULT RENDERING ────────────────────────────────────────────── */
function renderTTCMSummaryBar(rpt) {
  const s = ttcm[`r${rpt}`];
  if (rpt === 1 || rpt === 3) {
    return `<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
      <div class="stat-card" style="flex:1;min-width:120px;border-color:rgba(0,230,118,0.3);">
        <div class="stat-label">Added</div>
        <div class="stat-value green">${s.added}</div>
      </div>
      <div class="stat-card" style="flex:1;min-width:120px;border-color:rgba(255,82,82,0.3);">
        <div class="stat-label">Deleted</div>
        <div class="stat-value red">${s.deleted}</div>
      </div>
      <div class="stat-card" style="flex:1;min-width:120px;">
        <div class="stat-label">Total Changes</div>
        <div class="stat-value">${s.added + s.deleted}</div>
      </div>
    </div>`;
  }
  return `<div style="display:flex;gap:12px;margin-bottom:16px;">
    <div class="stat-card" style="flex:1;border-color:rgba(255,214,0,0.3);">
      <div class="stat-label">Attribute Changes</div>
      <div class="stat-value" style="color:var(--yellow)">${s.changed}</div>
    </div>
  </div>`;
}

function renderTTCMTable(rpt, cols, rows) {
  if (!rows.length) return `<div class="empty"><div class="icon">✅</div>No changes detected.</div>`;

  // Columns to highlight as "changed" pairs in R2 and R4
  const changePairs = {
    2: [['prev_cyttna','cur_cyttna'],['prev_cydcin','cur_cydcin'],['prev_cypraf','cur_cypraf'],['prev_cyatvt','cur_cyatvt']],
    4: [['prev_cztmof','cur_cztmof'],['prev_czttyo','cur_czttyo'],['prev_czatvt','cur_czatvt']],
  };
  const pairs = changePairs[rpt] || [];

  const isChange = (col, row) => pairs.some(([p, c]) => (col === p || col === c) && row[p] !== row[c]);

  const header = cols.map(c => `<th>${escHtml(c)}</th>`).join('');
  const body   = rows.map(row => {
    const isAdded   = row.change_type === 'ADDED';
    const isDeleted = row.change_type === 'DELETED';
    const rowStyle  = isAdded   ? 'background:rgba(0,230,118,0.07);'
                    : isDeleted ? 'background:rgba(255,82,82,0.07);'
                    : '';
    const cells = cols.map(col => {
      const val = row[col] ?? '';
      const highlight = isChange(col, row)
        ? 'background:rgba(255,214,0,0.15);color:var(--yellow);font-weight:700;'
        : '';
      const badge = col === 'change_type'
        ? `<span class="lang-badge" style="font-size:10px;background:${isAdded?'rgba(0,230,118,0.15)':'rgba(255,82,82,0.15)'};color:${isAdded?'var(--green)':'var(--accent3)'};">${escHtml(val)}</span>`
        : escHtml(val);
      return `<td style="${highlight}">${badge}</td>`;
    }).join('');
    return `<tr style="${rowStyle}">${cells}</tr>`;
  }).join('');

  return `<div style="overflow-x:auto;max-height:400px;overflow-y:auto;">
    <table class="data-table">
      <thead><tr>${header}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>
  <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">${rows.length.toLocaleString()} rows${rows.length===1000?' (limit 1000 — refine query if needed)':''}</div>`;
}

/* ── STEP 4: SUMMARY ─────────────────────────────────────────────── */
function buildTTCMSummary() {
  const prev   = getVal('ttcm-prev-period') || 'Previous Month';
  const cur    = getVal('ttcm-cur-period')  || 'Current Month';
  const el     = document.getElementById('ttcm-summary-body');
  if (!el) return;

  const anyRun = ttcm.r1.rows || ttcm.r2.rows || ttcm.r3.rows || ttcm.r4.rows;
  if (!anyRun) {
    el.innerHTML = `<div class="empty"><div class="icon">📊</div>Run at least one report in Steps 2–3 first.</div>`;
    document.getElementById('ttcm-jira-section').style.display = 'none';
    return;
  }

  const stat = (label, val, color) =>
    `<div class="stat-card" style="border-color:${color}20;">
       <div class="stat-label">${label}</div>
       <div class="stat-value" style="color:${color};font-size:28px;">${val !== null ? val : '—'}</div>
     </div>`;

  el.innerHTML = `
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px;text-align:center;letter-spacing:1px;text-transform:uppercase;">
      ${escHtml(prev)} → ${escHtml(cur)}
    </div>
    <div style="font-size:13px;font-weight:700;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">ML15 — Transaction Type Codes (SSCRTYP)</div>
    <div class="stats-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:20px;">
      ${stat('R1: Codes Added',   ttcm.r1.rows ? ttcm.r1.added   : null, 'var(--green)')}
      ${stat('R1: Codes Deleted', ttcm.r1.rows ? ttcm.r1.deleted : null, 'var(--accent3)')}
      ${stat('R2: Attrs Changed', ttcm.r2.rows ? ttcm.r2.changed : null, 'var(--yellow)')}
    </div>
    <div style="font-size:13px;font-weight:700;color:var(--text-muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">ML16 — HUB→CAMP Mappings (SSCRCEP)</div>
    <div class="stats-grid" style="grid-template-columns:repeat(3,1fr);">
      ${stat('R3: Mappings Added',   ttcm.r3.rows ? ttcm.r3.added   : null, 'var(--green)')}
      ${stat('R3: Mappings Deleted', ttcm.r3.rows ? ttcm.r3.deleted : null, 'var(--accent3)')}
      ${stat('R4: Mappings Changed', ttcm.r4.rows ? ttcm.r4.changed : null, 'var(--yellow)')}
    </div>`;

  document.getElementById('ttcm-jira-section').style.display = 'block';
  updateJiraBellVisibility();
}

/* ── JIRA: TTCM-SPECIFIC TICKET ──────────────────────────────────── */
async function createTTCMJiraTicket() {
  if (!jiraState.domain) { openJiraConfig(); return; }

  const prev    = getVal('ttcm-prev-period') || 'Previous Month';
  const cur     = getVal('ttcm-cur-period')  || 'Current Month';
  const today   = new Date().toISOString().split('T')[0];
  const totalML15 = (ttcm.r1.added + ttcm.r1.deleted + ttcm.r2.changed);
  const totalML16 = (ttcm.r3.added + ttcm.r3.deleted + ttcm.r4.changed);

  const btn = document.getElementById('btn-create-ttcm-jira');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Creating…'; }

  const adfBody = {
    version: 1, type: 'doc',
    content: [
      heading(2, 'TTCM Exception Report'),
      para(`Automated TTCM run completed on ${today}.`),
      para(`Comparison period: ${prev} → ${cur}`),
      heading(3, 'ML15 — Transaction Type Codes (SSCRTYP)'),
      bulletList([
        `Codes Added: ${ttcm.r1.rows ? ttcm.r1.added : 'Not run'}`,
        `Codes Deleted: ${ttcm.r1.rows ? ttcm.r1.deleted : 'Not run'}`,
        `Attribute Changes: ${ttcm.r2.rows ? ttcm.r2.changed : 'Not run'}`,
      ]),
      heading(3, 'ML16 — HUB→CAMP Mappings (SSCRCEP)'),
      bulletList([
        `Mappings Added: ${ttcm.r3.rows ? ttcm.r3.added : 'Not run'}`,
        `Mappings Deleted: ${ttcm.r3.rows ? ttcm.r3.deleted : 'Not run'}`,
        `Mapping Changes: ${ttcm.r4.rows ? ttcm.r4.changed : 'Not run'}`,
      ]),
      heading(3, 'Action Required'),
      para('Please review the changes listed above. Reply to this ticket confirming which changes are expected/approved. Flag any unexpected changes for investigation.'),
    ],
  };

  try {
    const resp = await fetch(jiraProxyUrl('rest/api/3/issue'), {
      method: 'POST',
      headers: jiraProxyHeaders(jiraState.email, jiraState.apiToken, jiraState.domain),
      body: JSON.stringify({
        fields: {
          project:     { key: jiraState.projectKey },
          summary:     `[Tally TTCM] ${prev} → ${cur} — ${totalML15 + totalML16} changes detected`,
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

    renderTTCMTicketCard(data.key);
    if (btn) btn.textContent = '✅ Ticket Created';
    showToast(`Jira ticket ${data.key} created.`, 'success');
    startJiraPolling();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '🎫 Create Jira Ticket'; }
    showToast('Failed to create Jira ticket: ' + e.message, 'error');
  }
}

function renderTTCMTicketCard(key) {
  const wrap = document.getElementById('ttcm-ticket-wrap');
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
          Claude will read the comments and analyse the TTCM changes.
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

/* ── CLAUDE AGENT (TTCM) — overrides jira.js refreshAgent ────────── */
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

    const data     = await resp.json();
    const comments = (data.comments || []);
    if (!comments.length) { showToast('No comments on this ticket yet.', 'info'); return; }

    const commentText = comments.map(c => {
      const author = c.author?.displayName || 'Unknown';
      const text   = extractADFText(c.body);
      return `[${new Date(c.created).toLocaleString()}] ${author}:\n${text}`;
    }).join('\n\n');

    if (btn) btn.textContent = '🤖 Asking Claude…';

    const ttcmSystemPrompt = `You are a TTCM (Transaction Type Code Mapping) analysis agent for Tally.
Read the Jira comments from the source/operations team and analyse the TTCM changes they are discussing.
Respond ONLY with a valid JSON object — no markdown, no explanation outside the JSON.

Schema:
{
  "hasConcerns": true | false,
  "summary": "plain English summary of what the team is saying",
  "criticalChanges": ["list any critical items needing immediate attention"],
  "recommendations": ["list recommended actions"],
  "approvalRecommendation": "APPROVE" | "INVESTIGATE" | "ESCALATE",
  "reasoning": "explanation of the recommendation"
}`;

    const agentResp = await fetch('http://localhost:9000/agent', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        comments:     commentText,
        matchKey:     'cyttyo',
        systemPrompt: ttcmSystemPrompt,
      }),
    });

    if (!agentResp.ok) {
      const err = await agentResp.json().catch(() => ({}));
      throw new Error(typeof err.error === 'string' ? err.error : err.error?.message || `HTTP ${agentResp.status}`);
    }

    const result = await agentResp.json();
    renderAgentResult(result);

  } catch (e) {
    showToast('Agent error: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🤖 Ask Agent'; }
  }
}

/* ── CLAUDE AGENT RESULT (TTCM) — overrides jira.js renderAgentResult */
function renderAgentResult(result) {
  const wrap = document.getElementById('agent-result-wrap');
  if (!wrap) return;
  wrap.style.display = 'block';

  const approvalColor = {
    APPROVE:     'var(--green)',
    INVESTIGATE: 'var(--yellow)',
    ESCALATE:    'var(--accent3)',
  }[result.approvalRecommendation] || 'var(--cyan)';

  const criticalHtml = (result.criticalChanges?.length)
    ? `<div style="margin-bottom:12px;">
         <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--accent3);margin-bottom:6px;">Critical Items</div>
         <ul style="margin:0;padding-left:16px;">
           ${result.criticalChanges.map(c => `<li style="font-size:12px;color:var(--text);margin-bottom:4px;">${escHtml(c)}</li>`).join('')}
         </ul>
       </div>` : '';

  const recoHtml = (result.recommendations?.length)
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
          <span style="font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--accent2);">Agent Analysis</span>
        </div>
        ${result.approvalRecommendation ? `
        <div style="padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;
                    background:${approvalColor}20;color:${approvalColor};">
          ${escHtml(result.approvalRecommendation)}
        </div>` : ''}
      </div>
      <p style="font-size:13px;color:var(--text);line-height:1.75;margin-bottom:14px;">${escHtml(result.summary || 'No summary provided.')}</p>
      ${criticalHtml}
      ${recoHtml}
      ${result.reasoning ? `<div style="font-size:11px;color:var(--text-muted);border-top:1px solid var(--border);padding-top:10px;margin-top:10px;line-height:1.7;">${escHtml(result.reasoning)}</div>` : ''}
      <div style="margin-top:12px;">
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('agent-result-wrap').style.display='none'">Dismiss</button>
      </div>
    </div>`;
}
