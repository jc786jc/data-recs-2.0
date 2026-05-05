/**
 * auth.js — Google OAuth 2.0 (GIS Token Client)
 *
 * ─── SETUP ───────────────────────────────────────────────────
 * 1. Go to https://console.cloud.google.com/apis/credentials
 * 2. Create an OAuth 2.0 Client ID (Web Application)
 * 3. Add your domain to "Authorized JavaScript Origins"
 *    e.g. http://localhost:5500 for VS Code Live Server
 * 4. Replace CLIENT_ID below with your actual Client ID
 * ─────────────────────────────────────────────────────────────
 */

// ⚠️  Replace this with your real OAuth Client ID
const CLIENT_ID = '494666259932-42fpq539erkdi22lj2f7ja4hc82unu5v.apps.googleusercontent.com';

const SCOPES = [
  'https://www.googleapis.com/auth/bigquery',
  'https://www.googleapis.com/auth/cloud-platform.read-only'
].join(' ');

let tokenClient = null;

/**
 * Initialise the GIS token client.
 * Called automatically once the GIS script loads (window.onload).
 */
window.onload = () => {
  if (window.google?.accounts?.oauth2) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: handleTokenResponse,
    });
  }
};

/**
 * Triggered when the user clicks "Continue with Google".
 * Falls back to demo mode when no real CLIENT_ID is configured.
 */
function handleGoogleSignIn() {
  if (CLIENT_ID === 'YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com') {
    activateDemoMode();
    return;
  }
  if (!tokenClient) {
    showToast('Google Identity Services not loaded. Check CLIENT_ID in auth.js.', 'error');
    return;
  }
  tokenClient.requestAccessToken();
}

/**
 * Callback fired by GIS after the user grants consent.
 * Fetches user profile and activates the main app.
 */
function handleTokenResponse(resp) {
  if (resp.error) {
    showToast('OAuth error: ' + resp.error, 'error');
    return;
  }
  state.token = resp.access_token;

  fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: 'Bearer ' + state.token }
  })
    .then(r => r.json())
    .then(info => {
      state.user = info;
      activateApp(info.name || info.email);
    })
    .catch(() => {
      // Proceed without user profile
      activateApp('User');
    });
}

/**
 * Pre-fills demo data and activates the app without real credentials.
 * Useful for local development / UI testing.
 */
function activateDemoMode() {
  state.token = 'DEMO_TOKEN';
  state.user  = { name: 'Demo User', email: 'demo@example.com' };
  activateApp('Demo User');

  // Pre-fill project config for demo
  setTimeout(() => {
    setVal('proj-a-id',      'my-source-project');
    setVal('proj-a-dataset', 'crm_data');
    setVal('proj-a-table',   'transactions');
    setVal('proj-a-desc',    'CRM Transactions');
    setVal('proj-b-id',      'my-finance-project');
    setVal('proj-b-dataset', 'finance_data');
    setVal('proj-b-table',   'ledger_entries');
    setVal('proj-b-desc',    'Finance Ledger');
    validateStep1();
  }, 100);
}

/**
 * Reveals the main application and updates the header.
 * @param {string} displayName
 */
function activateApp(displayName) {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('user-badge').style.display = 'flex';
  document.getElementById('user-name-display').textContent = displayName;
  document.getElementById('user-initials').textContent =
    displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  setConnected(true);

  // Load Jira config and show bell if configured (jira.js only loaded on data-recs page)
  if (typeof loadJiraConfig === 'function') {
    loadJiraConfig();
    updateJiraBellVisibility();
  }

  // Default to CSV mode on data-recs page
  if (typeof setStep1Mode === 'function') {
    setStep1Mode('csv');
  }
}

/**
 * Revokes the OAuth token and returns to the sign-in screen.
 */
function signOut() {
  if (state.token && state.token !== 'DEMO_TOKEN') {
    google.accounts.oauth2.revoke(state.token);
  }
  state.token = null;
  state.user  = null;

  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  document.getElementById('user-badge').style.display = 'none';
  setConnected(false);
}

/**
 * Updates the connection status pill in the header.
 * @param {boolean} connected
 */
function setConnected(connected) {
  const el = document.getElementById('conn-status');
  if (connected) {
    el.className = 'status-pill connected';
    el.innerHTML = '<div class="dot pulse"></div> Connected';
  } else {
    el.className = 'status-pill';
    el.innerHTML = '<div class="dot"></div> Not Connected';
  }
}
