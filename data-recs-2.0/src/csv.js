/**
 * csv.js — CSV upload, parsing, and in-browser computation
 * Used by Data Recs and TTCM when BigQuery access is unavailable.
 */

/* ── PARSER ──────────────────────────────────────────────────────── */

function parseCSVText(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  if (lines.length < 2) return { cols: [], rows: [] };

  function parseLine(line) {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) {
        out.push(cur.trim()); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  }

  const cols = parseLine(lines[0]).map(c => c.replace(/^"|"$/g, '').trim());
  const rows = lines.slice(1).filter(l => l.trim()).map(l => {
    const vals = parseLine(l);
    return Object.fromEntries(cols.map((c, i) => [c, (vals[i] ?? '').replace(/^"|"$/g, '')]));
  });
  return { cols, rows };
}

/* ── UPLOAD WIDGET ───────────────────────────────────────────────── */

function renderCSVUpload(containerId, onLoad, label) {
  const el = document.getElementById(containerId);
  if (!el) return;
  label = label || 'Drop CSV file here or click to browse';

  el.innerHTML = `
    <div id="${containerId}-dz"
      style="border:2px dashed var(--border);border-radius:10px;padding:28px;text-align:center;
             cursor:pointer;transition:border-color .2s,background .2s;background:var(--bg);"
      onclick="document.getElementById('${containerId}-inp').click()"
      ondragover="event.preventDefault();this.style.borderColor='var(--cyan)';this.style.background='rgba(0,229,255,0.04)'"
      ondragleave="this.style.borderColor='var(--border)';this.style.background='var(--bg)'"
      ondrop="_csvDrop(event,'${containerId}')">
      <div style="font-size:24px;margin-bottom:6px;">📄</div>
      <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:3px;">${escHtml(label)}</div>
      <div style="font-size:11px;color:var(--text-muted);">CSV · headers in first row</div>
      <input type="file" id="${containerId}-inp" accept=".csv,.txt" style="display:none"
        onchange="_csvFileInput(event,'${containerId}')"/>
    </div>
    <div id="${containerId}-preview" style="margin-top:10px;"></div>`;

  window[`_csvCb_${containerId}`] = onLoad;
}

function _csvDrop(event, id) {
  event.preventDefault();
  const dz = document.getElementById(`${id}-dz`);
  if (dz) { dz.style.borderColor = 'var(--border)'; dz.style.background = 'var(--bg)'; }
  const file = event.dataTransfer.files[0];
  if (file) _csvProcess(file, id);
}

function _csvFileInput(event, id) {
  const file = event.target.files[0];
  if (file) _csvProcess(file, id);
}

function _csvProcess(file, id) {
  const reader = new FileReader();
  reader.onload = e => {
    const result = parseCSVText(e.target.result);
    _csvShowPreview(id, file.name, result);
    const cb = window[`_csvCb_${id}`];
    if (typeof cb === 'function') cb(result, file.name);
    showToast(`${file.name} — ${result.rows.length.toLocaleString()} rows loaded`, 'success');
  };
  reader.readAsText(file);
}

function _csvShowPreview(id, fname, result) {
  const el = document.getElementById(`${id}-preview`);
  if (!el || !result.cols.length) return;
  const sample = result.rows.slice(0, 3);
  const hdr = result.cols.map(c => `<th>${escHtml(c)}</th>`).join('');
  const bdy = sample.map(r => `<tr>${result.cols.map(c => `<td>${escHtml(r[c]??'')}</td>`).join('')}</tr>`).join('');
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <span style="color:var(--green);font-size:12px;font-weight:700;">✓ ${escHtml(fname)}</span>
      <span style="font-size:11px;color:var(--text-muted);">${result.rows.length.toLocaleString()} rows · ${result.cols.length} cols</span>
    </div>
    <div style="overflow-x:auto;max-height:100px;overflow-y:auto;font-size:11px;">
      <table class="data-table"><thead><tr>${hdr}</tr></thead><tbody>${bdy}</tbody></table>
    </div>
    <div style="font-size:10px;color:var(--text-muted);margin-top:3px;">First 3 of ${result.rows.length.toLocaleString()} rows shown</div>`;
}

/* ── DATA-RECS: MODE TOGGLE ──────────────────────────────────────── */

function setDataMode(which, mode) {
  const isSrc   = which === 'src';
  const bqBtn   = document.getElementById(`${which}-mode-bq`);
  const csvBtn  = document.getElementById(`${which}-mode-csv`);
  const bqSec   = document.getElementById(`${which}-bq-section`);
  const csvSec  = document.getElementById(`${which}-csv-section`);

  const isCSV = mode === 'csv';
  if (bqBtn)  bqBtn.className  = isCSV ? 'btn btn-sm btn-secondary' : 'btn btn-sm btn-primary';
  if (csvBtn) csvBtn.className = isCSV ? 'btn btn-sm btn-primary'   : 'btn btn-sm btn-secondary';
  if (bqSec)  bqSec.style.display  = isCSV ? 'none'  : 'block';
  if (csvSec) csvSec.style.display = isCSV ? 'block' : 'none';

  if (isCSV) {
    state.csvMode = true;
    renderCSVUpload(`${which}-csv-upload`,
      (result) => {
        if (isSrc) { state.srcRows = result.rows; state.srcCols = result.cols; }
        else       { state.tgtRows = result.rows; state.tgtCols = result.cols; }
        _populateMatchKeyFromCSV(which, result.cols);
      },
      isSrc ? 'Drop Source CSV file here' : 'Drop Target CSV file here'
    );
  } else {
    if (isSrc) { state.srcRows = null; state.srcCols = null; }
    else       { state.tgtRows = null; state.tgtCols = null; }
    // Only exit CSV mode if both sides are back to BQ
    const otherCSV = isSrc
      ? document.getElementById('tgt-mode-csv')?.classList.contains('btn-primary')
      : document.getElementById('src-mode-csv')?.classList.contains('btn-primary');
    if (!otherCSV) state.csvMode = false;
  }
}

function _populateMatchKeyFromCSV(which, cols) {
  const sel = document.getElementById(`${which}-match-key`);
  if (sel) {
    sel.innerHTML = cols.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
    matchKey[which] = cols[0] || '';
    updateHashPreviews();
  }
}

/* ── DATA-RECS: IN-BROWSER RECONCILIATION ────────────────────────── */

function runCSVReconciliation() {
  const srcKeyCol = matchKey.src || getVal('join-key-src');
  const tgtKeyCol = matchKey.tgt || getVal('join-key-tgt');
  const amtCol    = getVal('amount-col');
  const wrap      = document.getElementById('rec-result-wrap');
  const body      = document.getElementById('rec-result-body');

  wrap.style.display = 'block';

  if (!state.srcRows || !state.tgtRows) {
    body.innerHTML = `<div class="alert alert-error">❌ Upload both source and target CSV files first (Steps 2 and 3).</div>`;
    return;
  }
  if (!srcKeyCol || !tgtKeyCol) {
    body.innerHTML = `<div class="alert alert-error">❌ Select match key columns in Steps 2 and 3.</div>`;
    return;
  }

  body.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:16px;">⚙️ Running in-browser reconciliation…</div>`;

  setTimeout(() => {
    const norm = v => String(v ?? '').trim().toUpperCase();

    const srcMap = new Map();
    state.srcRows.forEach(r => { const k = norm(r[srcKeyCol]); if (k) srcMap.set(k, r); });

    const tgtMap = new Map();
    state.tgtRows.forEach(r => { const k = norm(r[tgtKeyCol]); if (k) tgtMap.set(k, r); });

    let matched = 0, srcOnly = 0, tgtOnly = 0;
    const variances = [];

    srcMap.forEach((srcRow, key) => {
      if (tgtMap.has(key)) {
        matched++;
        if (amtCol) {
          const sv = parseFloat(srcRow[amtCol] || 0);
          const tv = parseFloat(tgtMap.get(key)[amtCol] || 0);
          if (Math.abs(sv - tv) > 0.001)
            variances.push({ key, src: sv.toFixed(2), tgt: tv.toFixed(2), variance: (sv - tv).toFixed(2) });
        }
      } else { srcOnly++; }
    });

    tgtMap.forEach((_, key) => { if (!srcMap.has(key)) tgtOnly++; });

    state.matchedCount   = matched;
    state.unmatchedCount = srcOnly + tgtOnly;
    state.srcOnlyCount   = srcOnly;
    state.tgtOnlyCount   = tgtOnly;
    state.srcCount       = srcMap.size;
    state.tgtCount       = tgtMap.size;

    const matchPct = srcMap.size > 0 ? ((matched / srcMap.size) * 100).toFixed(1) : '0.0';

    const varHtml = (amtCol && variances.length) ? `
      <div style="margin-top:16px;">
        <div style="font-size:12px;font-weight:700;color:var(--yellow);margin-bottom:8px;">
          ⚠ Amount Variances — ${variances.length} matched keys with differing <code>${escHtml(amtCol)}</code>
        </div>
        <div style="overflow-x:auto;max-height:200px;overflow-y:auto;">
          <table class="data-table">
            <thead><tr><th>Key</th><th>Source</th><th>Target</th><th>Variance</th></tr></thead>
            <tbody>${variances.slice(0, 200).map(v =>
              `<tr><td>${escHtml(v.key)}</td><td>${v.src}</td><td>${v.tgt}</td>
               <td style="color:var(--accent3);font-weight:700;">${v.variance}</td></tr>`
            ).join('')}</tbody>
          </table>
        </div>
      </div>` : '';

    body.innerHTML = `
      <div class="alert" style="border-color:var(--green);color:var(--green);margin-bottom:12px;">
        ✅ In-browser CSV reconciliation complete.
      </div>
      <div class="stats-grid" style="grid-template-columns:repeat(2,1fr);">
        <div class="stat-card">
          <div class="stat-label">Matched Keys</div>
          <div class="stat-value green">${matched.toLocaleString()}</div>
          <div class="stat-sub">${matchPct}% match rate</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Unmatched Keys</div>
          <div class="stat-value ${(srcOnly+tgtOnly)>0?'red':'green'}">${(srcOnly+tgtOnly).toLocaleString()}</div>
          <div class="stat-sub">Source only: ${srcOnly} · Target only: ${tgtOnly}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Source Records</div>
          <div class="stat-value">${srcMap.size.toLocaleString()}</div>
          <div class="stat-sub">from CSV upload</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Target Records</div>
          <div class="stat-value">${tgtMap.size.toLocaleString()}</div>
          <div class="stat-sub">from CSV upload</div>
        </div>
      </div>
      ${varHtml}
      ${_qvdBtn()}`;

    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 60);
}

/* ── TTCM: CSV STORAGE ───────────────────────────────────────────── */
const ttcmCSV = { ml15prev: null, ml15cur: null, ml16prev: null, ml16cur: null };

/* ── TTCM: IN-BROWSER REPORTS ────────────────────────────────────── */

function runCSVReport(rpt) {
  const bodyEl = document.getElementById(`r${rpt}-body`);
  const needs  = { 1:'ML15 Prev + ML15 Cur', 2:'ML15 Prev + ML15 Cur', 3:'ML16 Prev + ML16 Cur', 4:'ML16 Prev + ML16 Cur' };
  const checks = { 1: ttcmCSV.ml15prev && ttcmCSV.ml15cur, 2: ttcmCSV.ml15prev && ttcmCSV.ml15cur,
                   3: ttcmCSV.ml16prev && ttcmCSV.ml16cur, 4: ttcmCSV.ml16prev && ttcmCSV.ml16cur };

  if (!checks[rpt]) {
    bodyEl.innerHTML = `<div class="alert alert-error">❌ Upload ${needs[rpt]} CSV files in Step 1 first.</div>`;
    return;
  }

  bodyEl.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:16px;">⚙️ Running Report ${rpt} in browser…</div>`;

  setTimeout(() => {
    const fns  = { 1: _csvR1, 2: _csvR2, 3: _csvR3, 4: _csvR4 };
    const res  = fns[rpt]();
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
  }, 60);
}

function _csvR1() {
  const cols = ['cyttyo','change_type','prev_cyttsn','cur_cyttsn','prev_cyttna','cur_cyttna',
                'prev_cydcin','cur_cydcin','prev_cypraf','cur_cypraf','prev_cyatvt','cur_cyatvt','people_soft_id'];
  const pMap = new Map(ttcmCSV.ml15prev.map(r => [String(r.cyttyo||'').trim(), r]));
  const cMap = new Map(ttcmCSV.ml15cur.map(r =>  [String(r.cyttyo||'').trim(), r]));
  const rows = [];
  pMap.forEach((r,k) => { if (!cMap.has(k)) rows.push(_r1row(k,'DELETED',r,null)); });
  cMap.forEach((r,k) => { if (!pMap.has(k)) rows.push(_r1row(k,'ADDED',null,r)); });
  rows.sort((a,b) => a.change_type.localeCompare(b.change_type)||a.cyttyo.localeCompare(b.cyttyo));
  return { cols, rows };
}
function _r1row(k,type,p,c) {
  return { cyttyo:k, change_type:type,
    prev_cyttsn:p?.cyttsn||'', cur_cyttsn:c?.cyttsn||'',
    prev_cyttna:p?.cyttna||'', cur_cyttna:c?.cyttna||'',
    prev_cydcin:p?.cydcin||'', cur_cydcin:c?.cydcin||'',
    prev_cypraf:p?.cypraf||'', cur_cypraf:c?.cypraf||'',
    prev_cyatvt:p?.cyatvt||'', cur_cyatvt:c?.cyatvt||'',
    people_soft_id: c?.people_soft_id || p?.people_soft_id || '' };
}

function _csvR2() {
  const cols = ['cyttyo','prev_cyttna','cur_cyttna','prev_cydcin','cur_cydcin',
                'prev_cypraf','cur_cypraf','prev_cyatvt','cur_cyatvt','changed_by'];
  const pMap = new Map(ttcmCSV.ml15prev.map(r => [String(r.cyttyo||'').trim(), r]));
  const t = s => String(s||'').trim();
  const rows = [];
  ttcmCSV.ml15cur.forEach(c => {
    const k = t(c.cyttyo), p = pMap.get(k);
    if (!p) return;
    if (t(p.cyttna)!==t(c.cyttna)||t(p.cydcin)!==t(c.cydcin)||t(p.cypraf)!==t(c.cypraf)||t(p.cyatvt)!==t(c.cyatvt))
      rows.push({ cyttyo:k, prev_cyttna:t(p.cyttna), cur_cyttna:t(c.cyttna), prev_cydcin:t(p.cydcin), cur_cydcin:t(c.cydcin), prev_cypraf:t(p.cypraf), cur_cypraf:t(c.cypraf), prev_cyatvt:t(p.cyatvt), cur_cyatvt:t(c.cyatvt), changed_by:t(c.people_soft_id) });
  });
  rows.sort((a,b) => a.cyttyo.localeCompare(b.cyttyo));
  return { cols, rows };
}

function _csvR3() {
  const cols = ['change_type','cztcoe','cztcoz','czsscd','czdlcd','czimty',
                'prev_czttyo','cur_czttyo','prev_czatvt','cur_czatvt','people_soft_id'];
  const k5 = r => [r.cztcoe,r.cztcoz,r.czsscd,r.czdlcd,r.czimty].map(v=>String(v||'').trim()).join('|');
  const pMap = new Map(ttcmCSV.ml16prev.map(r => [k5(r), r]));
  const cMap = new Map(ttcmCSV.ml16cur.map(r =>  [k5(r), r]));
  const rows = [];
  pMap.forEach((r,k) => { if (!cMap.has(k)) rows.push(_r3row(k,'DELETED',r,null)); });
  cMap.forEach((r,k) => { if (!pMap.has(k)) rows.push(_r3row(k,'ADDED',null,r)); });
  rows.sort((a,b) => a.change_type.localeCompare(b.change_type)||a.cztcoe.localeCompare(b.cztcoe));
  return { cols, rows };
}
function _r3row(k,type,p,c) {
  const src = p||c;
  return { change_type:type, cztcoe:src.cztcoe||'', cztcoz:src.cztcoz||'', czsscd:src.czsscd||'',
    czdlcd:src.czdlcd||'', czimty:src.czimty||'',
    prev_czttyo:p?.czttyo||'', cur_czttyo:c?.czttyo||'',
    prev_czatvt:p?.czatvt||'', cur_czatvt:c?.czatvt||'',
    people_soft_id: c?.people_soft_id || p?.people_soft_id || '' };
}

function _csvR4() {
  const cols = ['cztcoe','cztcoz','czsscd','czdlcd','czimty',
                'prev_cztmof','cur_cztmof','prev_czttyo','cur_czttyo','prev_czatvt','cur_czatvt','changed_by'];
  const k5  = r => [r.cztcoe,r.cztcoz,r.czsscd,r.czdlcd,r.czimty].map(v=>String(v||'').trim()).join('|');
  const pMap = new Map(ttcmCSV.ml16prev.map(r => [k5(r), r]));
  const t = s => String(s||'').trim();
  const rows = [];
  ttcmCSV.ml16cur.forEach(c => {
    const k = k5(c), p = pMap.get(k);
    if (!p) return;
    if (t(p.cztmof)!==t(c.cztmof)||t(p.czttyo)!==t(c.czttyo)||t(p.czatvt)!==t(c.czatvt))
      rows.push({ cztcoe:t(c.cztcoe), cztcoz:t(c.cztcoz), czsscd:t(c.czsscd), czdlcd:t(c.czdlcd), czimty:t(c.czimty), prev_cztmof:t(p.cztmof), cur_cztmof:t(c.cztmof), prev_czttyo:t(p.czttyo), cur_czttyo:t(c.czttyo), prev_czatvt:t(p.czatvt), cur_czatvt:t(c.czatvt), changed_by:t(c.people_soft_id) });
  });
  rows.sort((a,b) => a.cztcoe.localeCompare(b.cztcoe));
  return { cols, rows };
}
