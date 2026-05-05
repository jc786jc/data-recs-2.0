/**
 * jira.js — Jira Cloud integration for Tally
 *
 * Responsibilities:
 *  • Store / load Jira config (domain, email, API token, project key)
 *  • Create a reconciliation exception ticket after Step 6
 *  • Poll the active ticket for new comments every 60 s
 *  • Parse comments for exclusion instructions (EXCLUDE: ID1, ID2 …)
 *  • Surface proposed exclusions in an in-app notification panel
 *  • Apply approved exclusions to the source query and re-run (user-confirmed)
 */

/* ── STATE ───────────────────────────────────────────────────── */
const jiraState = {
  domain:          '',   // e.g. myorg.atlassian.net
  email:           '',
  apiToken:        '',
  projectKey:      '',   // e.g. TALLY
  activeTicket:    null, // { key, id, url }
  lastCommentId:   null, // highest comment id seen so far
  pollTimer:       null,
  pendingExclusion: null, // exclusion waiting for user approval
};

/* ── CONFIG ──────────────────────────────────────────────────── */

function loadJiraConfig() {
  try {
    const saved = localStorage.getItem('tally_jira_config');
    if (saved) Object.assign(jiraState, JSON.parse(saved));
  } catch (_) {}
}

function saveJiraConfig() {
  const domain     = document.getElementById('jira-domain')?.value?.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const email      = document.getElementById('jira-email')?.value?.trim();
  const apiToken   = document.getElementById('jira-api-token')?.value?.trim();
  const projectKey = document.getElementById('jira-project-key')?.value?.trim().toUpperCase();

  if (!domain || !email || !apiToken || !projectKey) {
    showToast('All Jira fields are required.', 'warn');
    return;
  }

  Object.assign(jiraState, { domain, email, apiToken, projectKey });
  localStorage.setItem('tally_jira_config', JSON.stringify({ domain, email, apiToken, projectKey }));
  closeJiraConfig();
  showToast('Jira configuration saved.', 'success');
  updateJiraBellVisibility();
}

function openJiraConfig() {
  document.getElementById('jira-config-modal').style.display = 'flex';
  document.getElementById('jira-domain').value     = jiraState.domain     || '';
  document.getElementById('jira-email').value      = jiraState.email      || '';
  document.getElementById('jira-api-token').value  = jiraState.apiToken   || '';
  document.getElementById('jira-project-key').value = jiraState.projectKey || '';
}

function closeJiraConfig() {
  document.getElementById('jira-config-modal').style.display = 'none';
}

function jiraProxyUrl(path) {
  return `http://localhost:9000/jira-proxy/${path}`;
}

function jiraProxyHeaders(email, apiToken, domain) {
  return {
    'Authorization': 'Basic ' + btoa(`${email}:${apiToken}`),
    'X-Jira-Domain': domain,
    'X-Jira-Auth':   'Basic ' + btoa(`${email}:${apiToken}`),
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };
}

async function testJiraConnection() {
  const btn = document.getElementById('btn-jira-test');
  const result = document.getElementById('jira-test-result');
  btn.disabled = true;
  btn.textContent = 'Testing…';
  result.innerHTML = '';

  const domain     = document.getElementById('jira-domain')?.value?.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const email      = document.getElementById('jira-email')?.value?.trim();
  const apiToken   = document.getElementById('jira-api-token')?.value?.trim();
  const projectKey = document.getElementById('jira-project-key')?.value?.trim().toUpperCase();

  if (!domain || !email || !apiToken || !projectKey) {
    result.innerHTML = '<span style="color:var(--accent3);">Fill in all fields first.</span>';
    btn.disabled = false; btn.textContent = 'Test Connection';
    return;
  }

  try {
    const resp = await fetch(jiraProxyUrl(`rest/api/3/project/${projectKey}`), {
      headers: jiraProxyHeaders(email, apiToken, domain),
    });
    if (resp.status === 200) {
      const p = await resp.json();
      result.innerHTML = `<span style="color:var(--green);">✅ Connected — project "${escHtml(p.name)}" found.</span>`;
    } else if (resp.status === 401) {
      result.innerHTML = '<span style="color:var(--accent3);">❌ Auth failed — check email and API token.</span>';
    } else if (resp.status === 404) {
      result.innerHTML = `<span style="color:var(--accent3);">❌ Project key "${escHtml(projectKey)}" not found in this workspace.</span>`;
    } else {
      result.innerHTML = `<span style="color:var(--accent3);">❌ HTTP ${resp.status}</span>`;
    }
  } catch (e) {
    result.innerHTML = `<span style="color:var(--accent3);">❌ Network error — check domain and CORS. ${escHtml(e.message)}</span>`;
  }

  btn.disabled = false; btn.textContent = 'Test Connection';
}

/* ── CREATE TICKET ───────────────────────────────────────────── */

async function createJiraTicket() {
  if (!jiraState.domain) { openJiraConfig(); return; }

  const matched    = state.matchedCount;
  const unmatched  = state.unmatchedCount;
  const srcId      = getVal('proj-a-id');
  const dsA        = getVal('proj-a-dataset');
  const today      = new Date().toISOString().split('T')[0];
  const excTable   = document.getElementById('exceptions-table')?.value || `exceptions_${today.replace(/-/g, '_')}`;
  const excDataset = `${srcId}.${dsA}.${excTable}`;
  const matchPct   = state.srcCount > 0 ? ((matched / state.srcCount) * 100).toFixed(1) : '0.0';
  const unmatchPct = state.srcCount > 0 ? ((unmatched / state.srcCount) * 100).toFixed(1) : '0.0';

  const btn = document.getElementById('btn-create-jira');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Creating…'; }

  const adfBody = {
    version: 1, type: 'doc',
    content: [
      heading(2, 'Reconciliation Summary'),
      para(`Automated reconciliation run completed on ${today}.`),
      bulletList([
        bold(`Source records: ${state.srcCount.toLocaleString()}`),
        `Matched: ${matched.toLocaleString()} (${matchPct}%)`,
        bold(`Exceptions (unmatched): ${unmatched.toLocaleString()} (${unmatchPct}%)`),
      ]),
      heading(3, 'Exception Records Location'),
      para(`Exception records have been written to:`),
      codeBlock(excDataset),
      heading(3, 'Action Required'),
      para('Please review the exception records. If any are known/genuine exceptions that should be excluded from future reconciliations, reply to this ticket using the following format:'),
      codeBlock('EXCLUDE: ID1, ID2, ID3'),
      para('Or for a condition-based exclusion:'),
      codeBlock('EXCLUDE WHERE: transaction_type = \'ADJUSTMENT\''),
      para('The Tally reconciliation agent will detect your comment and raise a proposed exclusion for the team to approve before re-running.'),
    ],
  };

  try {
    const resp = await fetch(jiraProxyUrl('rest/api/3/issue'), {
      method: 'POST',
      headers: jiraProxyHeaders(jiraState.email, jiraState.apiToken, jiraState.domain),
      body: JSON.stringify({
        fields: {
          project:     { key: jiraState.projectKey },
          summary:     `[Tally] Data Reconciliation Exceptions — ${today} — ${unmatched.toLocaleString()} exceptions`,
          issuetype:   { name: 'Task' },
          description: adfBody,
        },
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.errorMessages?.[0] || (err.errors ? JSON.stringify(err.errors) : `HTTP ${resp.status}`));
    }

    const data = await resp.json();
    jiraState.activeTicket  = {
      key: data.key,
      id:  data.id,
      url: `https://${jiraState.domain}/browse/${data.key}`,
    };
    jiraState.lastCommentId = null;

    // Update the ticket info card in Step 6
    renderTicketCard(data.key);
    if (btn) btn.textContent = '✅ Ticket Created';
    showToast(`Jira ticket ${data.key} created — polling for responses.`, 'success');
    startJiraPolling();

    // Link ticket to the current history run
    if (typeof updateRunHistoryTicket === 'function' && state.currentRunId) {
      updateRunHistoryTicket(state.currentRunId, jiraState.activeTicket);
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '📋 Create Jira Ticket'; }
    showToast('Failed to create Jira ticket: ' + e.message, 'error');
  }
}

function renderTicketCard(key) {
  const wrap = document.getElementById('jira-ticket-wrap');
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
            Polling every 60 s for source team responses
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
          When the source team replies, click <strong style="color:var(--text);">Ask Agent</strong> —
          Claude will read the comments and propose an exclusion rule for your approval.
        </div>
        <button id="btn-ask-agent" onclick="refreshAgent()"
          style="flex-shrink:0;display:flex;align-items:center;gap:7px;padding:8px 16px;background:linear-gradient(135deg,rgba(179,136,255,0.15),rgba(0,229,255,0.1));border:1px solid rgba(179,136,255,0.4);border-radius:8px;color:var(--text);font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;">
          🤖 Ask Agent
        </button>
      </div>
    </div>
    <div id="agent-result-wrap" style="display:none;margin-top:12px;"></div>`;
}

/* ── CLAUDE AGENT ────────────────────────────────────────────── */

async function refreshAgent() {
  if (!jiraState.activeTicket?.key) {
    showToast('No active Jira ticket.', 'warn');
    return;
  }

  const btn = document.getElementById('btn-ask-agent');
  const resultWrap = document.getElementById('agent-result-wrap');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Reading comments…'; }
  if (resultWrap) resultWrap.style.display = 'none';

  try {
    // 1. Fetch all comments from Jira
    const resp = await fetch(
      jiraProxyUrl(`rest/api/3/issue/${jiraState.activeTicket.key}/comment?orderBy=created`),
      { headers: jiraProxyHeaders(jiraState.email, jiraState.apiToken, jiraState.domain) }
    );
    if (!resp.ok) throw new Error(`Jira fetch failed: HTTP ${resp.status}`);

    const data     = await resp.json();
    const comments = data.comments || [];

    if (comments.length === 0) {
      showToast('No comments on this ticket yet.', 'info');
      if (btn) { btn.disabled = false; btn.textContent = '🤖 Ask Agent'; }
      return;
    }

    // 2. Build plain text from all comments
    const commentText = comments.map(c => {
      const author = c.author?.displayName || 'Unknown';
      const text   = extractADFText(c.body);
      const date   = new Date(c.created).toLocaleString();
      return `[${date}] ${author}:\n${text}`;
    }).join('\n\n');

    if (btn) btn.textContent = '🤖 Asking Claude…';

    // 3. Send to Claude agent via local proxy
    const agentResp = await fetch('http://localhost:9000/agent', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        comments: commentText,
        matchKey: matchKey.src || 'match_key',
      }),
    });

    if (!agentResp.ok) {
      const err = await agentResp.json().catch(() => ({}));
      const msg = typeof err.error === 'string' ? err.error
                : err.error?.message || err.message
                || `HTTP ${agentResp.status}`;
      throw new Error(msg);
    }

    const result = await agentResp.json();
    renderAgentResult(result, commentText);

  } catch (e) {
    showToast('Agent error: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🤖 Ask Agent'; }
  }
}

function renderAgentResult(result, rawComments) {
  const wrap = document.getElementById('agent-result-wrap');
  if (!wrap) return;

  if (!result.hasExclusion) {
    wrap.style.display = 'block';
    wrap.innerHTML = `
      <div style="padding:16px 18px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <span>🤖</span>
          <span style="font-size:12px;font-weight:700;color:var(--text);">Agent Response</span>
        </div>
        <p style="font-size:13px;color:var(--text-muted);line-height:1.7;margin:0;">${escHtml(result.explanation || 'No exclusion request detected in the comments.')}</p>
      </div>`;
    return;
  }

  // Store for apply step
  jiraState.pendingExclusion = result;

  wrap.style.display = 'block';
  wrap.innerHTML = `
    <div style="padding:18px 20px;background:rgba(179,136,255,0.06);border:1px solid rgba(179,136,255,0.3);border-radius:10px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
        <span style="font-size:18px;">🤖</span>
        <span style="font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--accent2);">Agent Proposal</span>
      </div>

      <p style="font-size:13px;color:var(--text);line-height:1.75;margin-bottom:14px;">${escHtml(result.explanation)}</p>

      ${result.sqlClause ? `
      <div style="margin-bottom:14px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px;">Proposed SQL</div>
        <div style="font-family:var(--mono);font-size:12px;color:var(--green);background:var(--bg);padding:10px 12px;border-radius:6px;border:1px solid var(--border);white-space:pre-wrap;">${escHtml(result.sqlClause)}</div>
      </div>` : ''}

      <div style="font-size:11px;color:var(--text-muted);margin-bottom:14px;">
        Review the proposed change above. Clicking <strong style="color:var(--text);">Apply &amp; Re-run</strong> will update
        the source query and navigate to Step 4 for you to confirm before executing.
      </div>

      <div class="btn-row">
        <button class="btn btn-primary btn-sm" onclick="applyAgentExclusion()">✅ Apply &amp; Re-run</button>
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('agent-result-wrap').style.display='none'">Dismiss</button>
      </div>
    </div>`;
}

function applyAgentExclusion() {
  const result = jiraState.pendingExclusion;
  if (!result?.sqlClause) return;

  const srcQueryEl = document.getElementById('src-query');
  if (!srcQueryEl) { showToast('Source query not found. Go to Step 2 first.', 'warn'); return; }

  let sql      = srcQueryEl.value.trim();
  const hasWhere = /\bWHERE\b/i.test(sql);
  const clause   = result.sqlClause.replace(/^\s*(WHERE|AND)\s+/i, '');

  sql += hasWhere
    ? `\n  AND ${clause} -- excluded by Agent (${jiraState.activeTicket?.key || 'Jira'})`
    : `\nWHERE ${clause} -- excluded by Agent (${jiraState.activeTicket?.key || 'Jira'})`;

  srcQueryEl.value       = sql;
  jiraState.pendingExclusion = null;

  document.getElementById('agent-result-wrap').style.display = 'none';
  showToast('Exclusion applied. Confirm the query in Step 4 then re-run.', 'success');

  goStep(4);
  buildRecQuery();

  const banner = document.getElementById('jira-rerun-banner');
  if (banner) {
    banner.style.display = 'block';
    banner.innerHTML = `
      <div class="alert" style="border-color:var(--accent2);margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:16px;">
        <div>
          <strong style="color:var(--accent2);">🤖 Agent exclusion applied</strong> — source query updated.
          Review the SQL below, then re-run reconciliation.
        </div>
        <button class="btn btn-primary btn-sm" onclick="runReconciliation()">▶ Re-run Now</button>
      </div>`;
  }
}

/* ── POLLING ─────────────────────────────────────────────────── */

function startJiraPolling() {
  stopJiraPolling();
  jiraState.pollTimer = setInterval(pollJiraComments, 60_000);
}

function stopJiraPolling() {
  if (jiraState.pollTimer) { clearInterval(jiraState.pollTimer); jiraState.pollTimer = null; }
}

async function pollJiraComments() {
  if (!jiraState.activeTicket?.key || !jiraState.domain) return;

  try {
    const resp = await fetch(
      jiraProxyUrl(`rest/api/3/issue/${jiraState.activeTicket.key}/comment?orderBy=created`),
      { headers: jiraProxyHeaders(jiraState.email, jiraState.apiToken, jiraState.domain) }
    );
    if (!resp.ok) return;

    const data     = await resp.json();
    const comments = data.comments || [];

    // Update last-polled timestamp
    const pollEl = document.getElementById('jira-last-poll');
    if (pollEl) pollEl.textContent = `· last checked ${new Date().toLocaleTimeString()}`;

    if (comments.length === 0) return;

    // Detect new comments since last seen
    const lastSeen   = jiraState.lastCommentId;
    const newComments = lastSeen
      ? comments.filter(c => Number(c.id) > Number(lastSeen))
      : comments;

    // Always advance the pointer
    jiraState.lastCommentId = comments[comments.length - 1].id;

    newComments.forEach(c => {
      const text      = extractADFText(c.body);
      const exclusion = parseExclusion(text);
      const notif     = {
        id:        c.id,
        author:    c.author?.displayName || 'Unknown',
        text,
        created:   c.created,
        exclusion,
        ticketKey: jiraState.activeTicket.key,
        ticketUrl: jiraState.activeTicket.url,
      };

      if (exclusion) {
        jiraState.pendingExclusion = exclusion;
        showNotifPanel(notif);
        bumpBell();
      } else {
        showToast(`💬 New comment on ${jiraState.activeTicket.key} from ${notif.author}`, 'info');
      }
    });
  } catch (e) {
    console.warn('[Jira] Poll error:', e.message);
  }
}

/* ── COMMENT PARSING ─────────────────────────────────────────── */

function extractADFText(adf) {
  if (typeof adf === 'string') return adf.trim();
  if (!adf) return '';
  function walk(node) {
    if (!node) return '';
    if (node.type === 'text') return node.text || '';
    if (node.type === 'hardBreak' || node.type === 'rule') return '\n';
    if (Array.isArray(node.content)) return node.content.map(walk).join('');
    if (Array.isArray(node)) return node.map(walk).join('');
    return '';
  }
  const text = walk(adf).replace(/\s+/g, ' ').trim();
  return text || JSON.stringify(adf);
}

function parseExclusion(text) {
  if (!text) return null;

  // EXCLUDE: val1, val2, val3
  const listMatch = text.match(/EXCLUDE\s*[:：]\s*(.+)/i);
  if (listMatch) {
    const values = listMatch[1].split(/[,;\n]+/).map(v => v.trim()).filter(Boolean);
    if (values.length) return { type: 'list', values, raw: listMatch[1].trim() };
  }

  // EXCLUDE WHERE: condition
  const condMatch = text.match(/EXCLUDE\s+WHERE\s*[:：]\s*(.+)/i);
  if (condMatch) {
    return { type: 'condition', condition: condMatch[1].trim(), raw: condMatch[0].trim() };
  }

  return null;
}

/* ── NOTIFICATION PANEL ──────────────────────────────────────── */

function bumpBell() {
  const badge = document.getElementById('jira-bell-badge');
  if (badge) { badge.style.display = 'flex'; }
}

function clearBell() {
  const badge = document.getElementById('jira-bell-badge');
  if (badge) { badge.style.display = 'none'; }
}

function openBell() {
  const panel = document.getElementById('jira-notif-panel');
  if (panel && panel.style.display !== 'flex') {
    panel.style.display = 'flex';
  } else if (!jiraState.activeTicket) {
    showToast('No active Jira ticket. Create one from Step 6 Summary.', 'info');
  }
  clearBell();
}

function updateJiraBellVisibility() {
  const bell = document.getElementById('jira-bell-btn');
  if (bell) bell.style.display = jiraState.domain ? 'flex' : 'none';
}

function showNotifPanel(notif) {
  const panel   = document.getElementById('jira-notif-panel');
  const content = document.getElementById('jira-notif-content');
  if (!panel || !content) return;

  let exclusionHtml = '';
  const ex = notif.exclusion;

  const aiNoteHtml = `
    <div style="margin-top:16px;padding:16px 18px;background:rgba(179,136,255,0.06);border:1px solid rgba(179,136,255,0.25);border-radius:10px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span style="font-size:15px;">🤖</span>
        <span style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--accent2);">AI Agent Opportunity</span>
      </div>
      <p style="font-size:12px;color:var(--text-muted);line-height:1.8;margin:0;">
        This comment can be passed to an <strong style="color:var(--text);">Agentic AI</strong> (e.g. Claude) to interpret the
        exclusion request in natural language, generate the precise SQL exclusion clause,
        update the reconciliation query, and re-run — all with your approval.
        This capability is on the <strong style="color:var(--text);">Tally roadmap</strong>.
      </p>
    </div>`;

  if (ex?.type === 'list') {
    exclusionHtml = `
      <div class="jira-exclusion-box">
        <div class="jira-excl-label">Exclusion Request Detected</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
          ${ex.values.length} value(s) mentioned for exclusion:
        </div>
        <div class="jira-excl-values">${ex.values.map(v => `<span class="excl-tag">${escHtml(v)}</span>`).join('')}</div>
        <div class="btn-row" style="margin-top:14px;">
          <button class="btn btn-secondary btn-sm" onclick="dismissNotifPanel()">Acknowledge</button>
        </div>
      </div>
      ${aiNoteHtml}`;
  } else if (ex?.type === 'condition') {
    exclusionHtml = `
      <div class="jira-exclusion-box">
        <div class="jira-excl-label">Condition Exclusion Requested</div>
        <div style="font-family:var(--mono);font-size:11px;color:var(--text);background:var(--bg);padding:8px 10px;border-radius:6px;margin-bottom:8px;">
          WHERE NOT (${escHtml(ex.condition)})
        </div>
        <div class="btn-row" style="margin-top:14px;">
          <button class="btn btn-secondary btn-sm" onclick="dismissNotifPanel()">Acknowledge</button>
        </div>
      </div>
      ${aiNoteHtml}`;
  } else {
    exclusionHtml = `
      ${aiNoteHtml}`;
  }

  content.innerHTML = `
    <div class="jira-panel-header">
      <div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:3px;">New comment on</div>
        <a href="${notif.ticketUrl}" target="_blank" style="color:var(--accent);font-weight:700;font-size:15px;">${escHtml(notif.ticketKey)} ↗</a>
      </div>
      <button class="btn btn-sm btn-secondary" onclick="dismissNotifPanel()">✕ Close</button>
    </div>
    <div class="jira-comment-bubble">
      <div class="jira-comment-meta">
        <strong style="color:var(--text);">${escHtml(notif.author)}</strong>
        <span style="color:var(--text-muted);">· ${new Date(notif.created).toLocaleString()}</span>
      </div>
      <div class="jira-comment-text">${escHtml(notif.text)}</div>
    </div>
    ${exclusionHtml}`;

  panel.style.display = 'flex';
}

function dismissNotifPanel() {
  document.getElementById('jira-notif-panel').style.display = 'none';
}

/* ── APPLY EXCLUSION & RE-RUN ────────────────────────────────── */

function applyExclusionAndRerun() {
  const ex = jiraState.pendingExclusion;
  if (!ex) return;

  const keyCol     = matchKey.src;
  const srcQueryEl = document.getElementById('src-query');
  if (!srcQueryEl || !keyCol) {
    showToast('Cannot apply exclusion — source query or match key not configured.', 'warn');
    return;
  }

  let sql = srcQueryEl.value.trim();
  const hasWhere = /\bWHERE\b/i.test(sql);

  if (ex.type === 'list') {
    const quoted = ex.values.map(v => `'${v.replace(/'/g, "''")}'`).join(', ');
    const clause = `${keyCol} NOT IN (${quoted})`;
    sql += hasWhere
      ? `\n  AND ${clause} -- exclusion from ${jiraState.activeTicket?.key || 'Jira'}`
      : `\nWHERE ${clause} -- exclusion from ${jiraState.activeTicket?.key || 'Jira'}`;
  } else if (ex.type === 'condition') {
    const clause = `NOT (${ex.condition})`;
    sql += hasWhere
      ? `\n  AND ${clause} -- exclusion from ${jiraState.activeTicket?.key || 'Jira'}`
      : `\nWHERE ${clause} -- exclusion from ${jiraState.activeTicket?.key || 'Jira'}`;
  }

  srcQueryEl.value = sql;
  jiraState.pendingExclusion = null;
  dismissNotifPanel();

  showToast('Exclusion applied to source query. Review it in Step 2 before re-running.', 'success');

  // Navigate to Step 4 for review — user sees the rebuilt query and clicks Run
  goStep(4);
  buildRecQuery();

  // Show an approval banner in Step 4
  const recWrap = document.getElementById('rec-result-wrap');
  if (recWrap) recWrap.style.display = 'none';

  const banner = document.getElementById('jira-rerun-banner');
  if (banner) {
    banner.style.display = 'block';
    banner.innerHTML = `
      <div class="alert" style="border-color:var(--green);margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:16px;">
        <div>
          <strong style="color:var(--green);">Exclusion applied from Jira</strong> — source query updated.
          Review the generated SQL below, then re-run reconciliation.
        </div>
        <button class="btn btn-primary btn-sm" onclick="runReconciliation()">▶ Re-run Now</button>
      </div>`;
  }
}

/* ── ADF HELPERS ─────────────────────────────────────────────── */

function heading(level, text) {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}
function para(text) {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}
function bold(text) { return text; } // used as plain string in bulletList helper
function bulletList(items) {
  return {
    type: 'bulletList',
    content: items.map(item => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: item }] }],
    })),
  };
}
function codeBlock(text) {
  return { type: 'codeBlock', attrs: {}, content: [{ type: 'text', text }] };
}
