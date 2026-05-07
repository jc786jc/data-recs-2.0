"""
Tally local dev server
  • Serves static files on http://localhost:8080
  • Proxies /jira-proxy/* -> Atlassian REST API (bypasses browser CORS)
  • /agent         -> Claude API (keeps API key server-side)

Usage:
    python server.py
"""

import json
import time
import urllib.request
import urllib.error
from http.server import HTTPServer, SimpleHTTPRequestHandler

ANTHROPIC_API_KEY = ""
CLAUDE_MODEL      = "claude-sonnet-4-6"

AGENT_SYSTEM = """You are a data reconciliation agent for Tally, a financial data controls platform.

Your job is to read Jira ticket comments from a source team and determine whether they are
requesting that certain records be excluded from a reconciliation run.

The team may write in plain English — e.g.:
  "TXN-001 and TXN-002 are genuine FX netting transactions, please exclude them"
  "Exclude all records where transaction_type = ADJUSTMENT"
  "These IDs are known breaks: TXN-100, TXN-101, TXN-200"

You must respond ONLY with a valid JSON object — no markdown, no explanation outside the JSON.

Schema:
{
  "hasExclusion": true | false,
  "explanation": "plain English summary of what the team is asking",
  "exclusionType": "list" | "condition" | null,
  "values": ["val1", "val2"] | null,
  "condition": "SQL condition string" | null,
  "sqlClause": "full WHERE / AND clause ready to append" | null
}"""


class TallyHandler(SimpleHTTPRequestHandler):

    # ── CORS pre-flight ──────────────────────────────────────────
    def do_OPTIONS(self):
        self._cors(200)
        self.end_headers()

    # ── Static files ─────────────────────────────────────────────
    def do_GET(self):
        if self.path.startswith('/jira-proxy/'):
            self._proxy('GET')
        else:
            super().do_GET()

    # ── POST routing ─────────────────────────────────────────────
    def do_POST(self):
        if self.path.startswith('/jira-proxy/'):
            self._proxy('POST')
        elif self.path == '/agent':
            self._claude_agent()
        elif self.path == '/starburst-query':
            self._starburst_query()
        else:
            self.send_error(405)

    # ── Claude agent endpoint ────────────────────────────────────
    def _claude_agent(self):
        length  = int(self.headers.get('Content-Length', 0))
        payload = json.loads(self.rfile.read(length)) if length else {}

        comments     = payload.get('comments', '').strip()
        match_key    = payload.get('matchKey', 'match_key')
        system       = payload.get('systemPrompt') or AGENT_SYSTEM

        print(f'  [Agent] comments length: {len(comments)}, preview: {repr(comments[:200])}')

        if not comments:
            self._json_error(400, 'No comments provided')
            return

        user_msg = f"Match key column: {match_key}\n\nJira comments:\n{comments}"

        body = json.dumps({
            "model":      CLAUDE_MODEL,
            "max_tokens": 1024,
            "system":     system,
            "messages":   [{"role": "user", "content": user_msg}],
        }).encode()

        req = urllib.request.Request(
            'https://api.anthropic.com/v1/messages',
            data=body, method='POST'
        )
        req.add_header('x-api-key',          ANTHROPIC_API_KEY)
        req.add_header('anthropic-version',  '2023-06-01')
        req.add_header('content-type',       'application/json')

        try:
            with urllib.request.urlopen(req) as resp:
                result = json.loads(resp.read())
                text   = result['content'][0]['text'].strip()
                # Strip markdown code fences if Claude wraps in ```json
                if text.startswith('```'):
                    text = text.split('\n', 1)[1].rsplit('```', 1)[0].strip()
                self._relay(200, text.encode())
        except urllib.error.HTTPError as e:
            body = e.read()
            print(f'  [Agent] Claude API error {e.code}: {body.decode()}')
            try:
                err_json = json.loads(body)
                msg = err_json.get('error', {}).get('message', f'HTTP {e.code}')
            except Exception:
                msg = f'HTTP {e.code}'
            self._json_error(e.code, msg)
        except Exception as e:
            print(f'  [Agent] Exception: {e}')
            self._json_error(502, str(e))

    # ── Starburst / Trino query proxy ───────────────────────────
    def _starburst_query(self):
        length  = int(self.headers.get('Content-Length', 0))
        payload = json.loads(self.rfile.read(length)) if length else {}

        host     = payload.get('host', '').strip()
        sql      = payload.get('sql', '').strip()
        catalog  = payload.get('catalog', '').strip()
        schema   = payload.get('schema',  '').strip()
        username = payload.get('username', 'tally').strip()
        token    = payload.get('token', '').strip()

        if not host or not sql:
            self._json_error(400, 'host and sql are required')
            return

        headers = {
            'X-Trino-User':    username or 'tally',
            'X-Trino-Catalog': catalog,
            'X-Trino-Schema':  schema,
            'Content-Type':    'application/json',
            'Accept':          'application/json',
        }
        if token:
            headers['Authorization'] = f'Bearer {token}'

        protocol = 'https' if not host.startswith('http') else ''
        base_url = f'{protocol}{"://" if protocol else ""}{host}' if protocol else host

        print(f'  [Starburst] {host} → {sql[:120]}')

        try:
            # Step 1: Submit query
            req = urllib.request.Request(
                f'{base_url}/v1/statement',
                data=sql.encode(), method='POST',
                headers=headers
            )
            with urllib.request.urlopen(req, timeout=30) as r:
                result = json.loads(r.read())

            # Step 2: Poll nextUri until complete
            cols, rows = [], []
            max_polls  = 120  # 60 seconds max
            for _ in range(max_polls):
                if result.get('columns') and not cols:
                    cols = [c['name'] for c in result['columns']]
                for row in result.get('data') or []:
                    rows.append(dict(zip(cols, row)))
                next_uri = result.get('nextUri')
                if not next_uri:
                    break
                time.sleep(0.5)
                req = urllib.request.Request(next_uri, headers=headers)
                with urllib.request.urlopen(req, timeout=30) as r:
                    result = json.loads(r.read())

            # Surface any query error from Starburst
            error = result.get('error')
            if error:
                msg = error.get('message') or error.get('errorName') or 'Starburst query error'
                self._json_error(400, msg)
                return

            self._relay(200, json.dumps({'cols': cols, 'rows': rows}).encode())

        except urllib.error.HTTPError as e:
            body = e.read()
            print(f'  [Starburst] HTTP {e.code}: {body[:200]}')
            try:
                msg = json.loads(body).get('error', {}).get('message', f'HTTP {e.code}')
            except Exception:
                msg = f'HTTP {e.code}'
            self._json_error(e.code, msg)
        except Exception as e:
            print(f'  [Starburst] Exception: {e}')
            self._json_error(502, str(e))

    # ── Jira proxy ───────────────────────────────────────────────
    def _proxy(self, method):
        jira_path = self.path[len('/jira-proxy/'):]
        domain    = self.headers.get('X-Jira-Domain', '').strip()
        auth      = self.headers.get('X-Jira-Auth',   '').strip()

        if not domain:
            self._json_error(400, 'X-Jira-Domain header missing')
            return

        url  = f'https://{domain}/{jira_path}'
        body = None
        if method == 'POST':
            length = int(self.headers.get('Content-Length', 0))
            body   = self.rfile.read(length) if length else None

        req = urllib.request.Request(url, data=body, method=method)
        req.add_header('Authorization', auth)
        req.add_header('Content-Type',  'application/json')
        req.add_header('Accept',        'application/json')

        try:
            with urllib.request.urlopen(req) as resp:
                self._relay(resp.status, resp.read())
        except urllib.error.HTTPError as e:
            self._relay(e.code, e.read())
        except Exception as e:
            self._json_error(502, str(e))

    # ── Helpers ──────────────────────────────────────────────────
    def _relay(self, status, body):
        self._cors(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body)

    def _json_error(self, status, msg):
        self._cors(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'error': msg}).encode())

    def _cors(self, status):
        self.send_response(status)
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers',
                         'Content-Type, Authorization, X-Jira-Domain, X-Jira-Auth')

    def log_message(self, fmt, *args):
        print(f'  {self.address_string()} -- {fmt % args}')


if __name__ == '__main__':
    port   = 9000
    server = HTTPServer(('', port), TallyHandler)
    print(f'\n  Tally — The Controls App running at http://localhost:{port}')
    print(f'  Claude agent ready ({CLAUDE_MODEL})\n')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n  Server stopped.')
