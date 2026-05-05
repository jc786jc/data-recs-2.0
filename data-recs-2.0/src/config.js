/**
 * config.js — Named reconciliation config save/load
 * Persists all Step 1-3 fields + queries + normalization to localStorage.
 */

const CONFIGS_KEY = 'tally_saved_configs';

const CONFIG_FIELDS = [
  'proj-a-type', 'proj-a-id', 'proj-a-dataset', 'proj-a-table', 'proj-a-desc', 'proj-a-location',
  'proj-a-sb-host', 'proj-a-sb-catalog', 'proj-a-sb-username',
  'proj-b-type', 'proj-b-id', 'proj-b-dataset', 'proj-b-table', 'proj-b-desc', 'proj-b-location',
  'proj-b-sb-host', 'proj-b-sb-catalog', 'proj-b-sb-username',
  'proj-c-id', 'proj-c-dataset', 'proj-c-location',
  'secret-salt',
  'src-query', 'tgt-query',
  'src-lpad-width', 'tgt-lpad-width',
  'join-key-src', 'join-key-tgt', 'join-type', 'amount-col', 'extra-cols',
];

const CONFIG_CHECKBOXES = [
  'src-norm-trim', 'src-norm-upper', 'src-norm-lpad',
  'tgt-norm-trim', 'tgt-norm-upper', 'tgt-norm-lpad',
];

/* ── Storage helpers ──────────────────────────────────────── */

function _loadConfigs() {
  try { return JSON.parse(localStorage.getItem(CONFIGS_KEY) || '{}'); }
  catch { return {}; }
}

function _saveConfigs(configs) {
  localStorage.setItem(CONFIGS_KEY, JSON.stringify(configs));
}

/* ── Public API ───────────────────────────────────────────── */

function saveConfig(name) {
  if (!name?.trim()) { showToast('Enter a config name', 'warn'); return; }
  name = name.trim();

  const data = { savedAt: new Date().toISOString(), fields: {}, checkboxes: {}, matchKey: {} };

  CONFIG_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) data.fields[id] = el.value;
  });

  CONFIG_CHECKBOXES.forEach(id => {
    const el = document.getElementById(id);
    if (el) data.checkboxes[id] = el.checked;
  });

  // matchKey is a module-level object in app.js
  if (typeof matchKey !== 'undefined') {
    data.matchKey = { src: matchKey.src, tgt: matchKey.tgt };
  }

  const configs = _loadConfigs();
  configs[name] = data;
  _saveConfigs(configs);

  showToast(`Config "${name}" saved`, 'success');
  renderConfigList();
}

function loadConfig(name) {
  const configs = _loadConfigs();
  const data = configs[name];
  if (!data) { showToast('Config not found', 'error'); return; }

  CONFIG_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (el && data.fields?.[id] !== undefined) el.value = data.fields[id];
  });

  CONFIG_CHECKBOXES.forEach(id => {
    const el = document.getElementById(id);
    if (el && data.checkboxes?.[id] !== undefined) el.checked = data.checkboxes[id];
  });

  if (typeof matchKey !== 'undefined' && data.matchKey) {
    matchKey.src = data.matchKey.src || '';
    matchKey.tgt = data.matchKey.tgt || '';
  }

  // Re-apply show/hide for Starburst fields, then validate
  if (typeof onTypeChange === 'function') { onTypeChange('src'); onTypeChange('tgt'); }
  if (typeof validateStep1 === 'function') validateStep1();
  if (typeof updateQueryHints === 'function') updateQueryHints();

  closeConfigManager();
  showToast(`Config "${name}" loaded — review Step 1 and continue`, 'success');
}

function deleteConfig(name) {
  const configs = _loadConfigs();
  delete configs[name];
  _saveConfigs(configs);
  showToast(`Config "${name}" deleted`, 'success');
  renderConfigList();
}

/* ── Modal ────────────────────────────────────────────────── */

function openConfigManager() {
  const modal = document.getElementById('config-manager-modal');
  if (modal) { modal.style.display = 'flex'; renderConfigList(); }
}

function closeConfigManager() {
  const modal = document.getElementById('config-manager-modal');
  if (modal) modal.style.display = 'none';
}

function renderConfigList() {
  const wrap = document.getElementById('config-list-wrap');
  if (!wrap) return;

  const configs = _loadConfigs();
  const names = Object.keys(configs);

  if (!names.length) {
    wrap.innerHTML = '<div style="font-size:13px;color:var(--text-muted);padding:16px 0;">No saved configs yet.</div>';
    return;
  }

  wrap.innerHTML = names.map(name => {
    const d = new Date(configs[name].savedAt);
    const dateStr = isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
    const srcDesc = configs[name].fields?.['proj-a-desc'] || configs[name].fields?.['proj-a-table'] || '—';
    const tgtDesc = configs[name].fields?.['proj-b-desc'] || configs[name].fields?.['proj-b-table'] || '—';
    return `
      <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--bg);border:1px solid var(--border);border-radius:10px;margin-bottom:10px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:3px;">${escHtml(name)}</div>
          <div style="font-size:11px;color:var(--text-muted);">${escHtml(srcDesc)} → ${escHtml(tgtDesc)}</div>
          ${dateStr ? `<div style="font-size:10px;color:var(--text-dim);margin-top:2px;">Saved ${dateStr}</div>` : ''}
        </div>
        <button class="btn btn-primary btn-sm" data-cfg="${escHtml(name)}" onclick="loadConfig(this.getAttribute('data-cfg'))">Load</button>
        <button class="btn btn-secondary btn-sm" data-cfg="${escHtml(name)}" onclick="if(confirm('Delete config \'' + this.getAttribute('data-cfg') + '\'?')) deleteConfig(this.getAttribute('data-cfg'))">Delete</button>
      </div>`;
  }).join('');
}
