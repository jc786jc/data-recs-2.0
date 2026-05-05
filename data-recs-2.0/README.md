# Data Recs 2.0

Cross-project BigQuery reconciliation web app.  
Sign in with Google OAuth → run SQL on Project A and Project B → auto-generate a cross-project FULL OUTER JOIN → view match summary and export CSV.

---

## Project Structure

```
data-recs-2.0/
├── index.html          ← Entry point (open this in a browser)
├── src/
│   ├── styles.css      ← All CSS (dark theme, grid bg, components)
│   ├── auth.js         ← Google OAuth 2.0 (GIS Token Client)
│   ├── bigquery.js     ← BigQuery REST API wrapper + demo data
│   └── app.js          ← Step navigation, query execution, rendering
└── README.md
```

---

## Quick Start (Demo Mode)

No GCP credentials needed to explore the UI:

1. Open `index.html` with **VS Code Live Server** (right-click → *Open with Live Server*)  
   or any local HTTP server — e.g. `npx serve .`
2. Click **Continue with Google** — the app detects the placeholder CLIENT_ID and enters **Demo Mode** automatically.
3. Walk through all 5 steps using synthetic data.

> **Note:** Opening `index.html` directly as a `file://` URL may block the Google Identity Services script. Always serve over HTTP.

---

## Production Setup (Real GCP Data)

### Step 1 — Create an OAuth Client ID

1. Go to [GCP Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. Click **Create Credentials → OAuth 2.0 Client ID**
3. Application type: **Web application**
4. Add your domain under **Authorized JavaScript Origins**  
   e.g. `http://localhost:5500` (VS Code Live Server) or `https://yourdomain.com`
5. Copy the generated **Client ID**

### Step 2 — Add the Client ID to the app

Open `src/auth.js` and replace line 13:

```js
// Before
const CLIENT_ID = 'YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com';

// After
const CLIENT_ID = '123456789-abcdefg.apps.googleusercontent.com';
```

### Step 3 — Enable BigQuery API

In your GCP project(s):  
[APIs & Services → Enable APIs → BigQuery API](https://console.cloud.google.com/apis/library/bigquery.googleapis.com)

### Step 4 — Grant IAM Roles

The authenticated user needs these roles on **both** projects:

| Role | Purpose |
|------|---------|
| `roles/bigquery.dataViewer` | Read table data |
| `roles/bigquery.jobUser`    | Run queries     |

---

## How Cross-Project Queries Work

BigQuery natively supports cross-project references in SQL:

```sql
SELECT *
FROM `project-a.dataset.table_a`  a
FULL OUTER JOIN `project-b.dataset.table_b`  b
  ON a.id = b.id
```

The job runs (and is **billed**) against **Project A**.  
Project B is referenced using its fully-qualified table name.  
No special configuration is needed — as long as the user has read access to both projects.

---

## Reconciliation Status Codes

| Status | Meaning |
|--------|---------|
| `MATCHED` | Record exists in both Source and Target |
| `SOURCE_ONLY` | Record exists in Source but **not** in Target |
| `TARGET_ONLY` | Record exists in Target but **not** in Source |

---

## Customising the Join

In **Step 4 — Match & Reconcile**, you can configure:

- **Join Type** — Full Outer (default), Inner, Left, Right
- **Match Key Column** — The column used to join Source ↔ Target (can differ by name)
- **Amount/Value Column** — Adds a variance column (`src_amount - tgt_amount`)
- **Additional Columns** — Extra columns to include in the output for context

The reconciliation SQL is auto-generated and editable before running.

---

## Deploying to Production

This is a **pure static site** — no backend required.

Deploy to any static hosting:

| Platform | Command |
|----------|---------|
| **GitHub Pages** | Push to `gh-pages` branch |
| **Netlify** | Drag & drop the folder |
| **Firebase Hosting** | `firebase deploy` |
| **GCS Bucket** | `gsutil rsync -r . gs://your-bucket` |

Remember to add your production domain to **Authorized JavaScript Origins** in GCP Console.

---

## Tech Stack

- Vanilla HTML / CSS / JavaScript — zero dependencies, zero build step
- [Google Identity Services](https://developers.google.com/identity/oauth2/web) — OAuth 2.0 token flow
- [BigQuery REST API](https://cloud.google.com/bigquery/docs/reference/rest) — query execution via `fetch()`
- Google Fonts: Syne + Space Mono
