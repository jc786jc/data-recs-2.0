"""
generate_dqm_test_data.py — DQM Test Data Generator

Creates two BigQuery tables in datarecsv2.dqm_data:

  camp_transactions   — 10,000 rows with seeded DQ issues
  ref_currency_codes  — 50 valid currency codes (for Reference check)

DQ issues seeded per column (to test all 4 rules):
  amount        — 5% null, 3% negative (conformity fail), 2% zero (specificity fail)
  currency_code — 5% null, 3% invalid 'XXX'/'N/A' (reference fail)
  account_number— 5% null, 3% blank string
  country_code  — 4% null, 2% invalid 'XX'/'ZZ' (conformity fail)
  transaction_type — 4% invalid codes

Usage:
    pip install google-cloud-bigquery
    python generate_dqm_test_data.py
"""

import random
import string
from datetime import date, timedelta

try:
    from google.cloud import bigquery
except ImportError:
    print('ERROR: Run   pip install google-cloud-bigquery   then retry.')
    raise

PROJECT  = 'datarecsv2'
DATASET  = 'dqm_data'
LOCATION = 'US'
N_ROWS   = 10_000

client = bigquery.Client(project=PROJECT)
random.seed(99)

# ── Value pools ────────────────────────────────────────────────────────────────

VALID_CURRENCIES = [
    'USD','EUR','GBP','JPY','CHF','AUD','CAD','HKD','SGD','NOK',
    'SEK','DKK','NZD','ZAR','INR','CNY','KRW','MXN','BRL','AED',
    'SAR','QAR','KWD','BHD','OMR','THB','IDR','MYR','PHP','PLN',
    'CZK','HUF','RON','TRY','ILS','RUB','PKR','EGP','NGN','KES',
    'GHS','TZS','UGX','MAD','TND','DZD','XOF','XAF','CLP','COP',
]

VALID_COUNTRIES = [
    'GB','US','DE','FR','JP','CH','AU','CA','HK','SG',
    'NO','SE','DK','NZ','ZA','IN','CN','KR','MX','BR',
    'AE','SA','QA','KW','BH','OM','TH','ID','MY','PH',
    'PL','CZ','HU','RO','TR','IL','RU','PK','EG','NG',
]

LOBS = ['RETAIL', 'CORPORATE', 'TREASURY', 'PRIVATE BANKING']
LOB_WEIGHTS = [0.40, 0.30, 0.20, 0.10]

VALID_TX_TYPES = ['PAYMENT', 'TRANSFER', 'FX_SPOT', 'FX_FORWARD', 'DEPOSIT',
                  'WITHDRAWAL', 'FEE', 'INTEREST', 'DIVIDEND', 'SETTLEMENT']
INVALID_TX_TYPES = ['UNKNOWN', 'TEST', 'DUMMY', 'TBD', 'N/A']

STATUSES = ['SETTLED', 'PENDING', 'FAILED']

def rand_date():
    base = date(2026, 4, 1)
    return (base + timedelta(days=random.randint(0, 29))).isoformat()

def rand_account():
    return ''.join(random.choices(string.digits, k=10))

def rand_ref():
    return 'REF' + ''.join(random.choices(string.digits, k=8))

def rand_ps_id():
    return 'PS' + str(random.randint(100000, 999999))

def pick_lob():
    return random.choices(LOBS, weights=LOB_WEIGHTS, k=1)[0]

# ── Generate rows ──────────────────────────────────────────────────────────────

def make_row(i):
    lob = pick_lob()
    r   = random.random

    # ── amount: 5% null, 3% negative, 2% zero, rest positive
    rv = random.random()
    if   rv < 0.05: amount = None
    elif rv < 0.08: amount = str(round(-random.uniform(1, 50000), 2))
    elif rv < 0.10: amount = '0'
    else:           amount = str(round(random.uniform(10, 500000), 2))

    # ── currency_code: 5% null, 3% invalid (XXX or N/A)
    cv = random.random()
    if   cv < 0.05: currency_code = None
    elif cv < 0.08: currency_code = random.choice(['XXX', 'N/A', 'ZZZ'])
    else:           currency_code = random.choice(VALID_CURRENCIES)

    # ── account_number: 5% null, 3% blank string
    av = random.random()
    if   av < 0.05: account_number = None
    elif av < 0.08: account_number = ''
    else:           account_number = rand_account()

    # ── country_code: 4% null, 2% invalid (XX or ZZ)
    gv = random.random()
    if   gv < 0.04: country_code = None
    elif gv < 0.06: country_code = random.choice(['XX', 'ZZ', 'QQ'])
    else:           country_code = random.choice(VALID_COUNTRIES)

    # ── transaction_type: 4% invalid
    tv = random.random()
    if tv < 0.04:   transaction_type = random.choice(INVALID_TX_TYPES)
    else:           transaction_type = random.choice(VALID_TX_TYPES)

    return {
        'transaction_id':   f'TXN{str(i).zfill(7)}',
        'line_of_business': lob,
        'processing_date':  rand_date(),
        'amount':           amount,
        'currency_code':    currency_code,
        'account_number':   account_number,
        'transaction_type': transaction_type,
        'country_code':     country_code,
        'reference_number': rand_ref(),
        'status':           random.choice(STATUSES),
        'created_by':       rand_ps_id(),
    }

rows = [make_row(i) for i in range(1, N_ROWS + 1)]

# ── Count seeded issues ────────────────────────────────────────────────────────
null_amt   = sum(1 for r in rows if r['amount'] is None)
neg_amt    = sum(1 for r in rows if r['amount'] and float(r['amount']) < 0)
zero_amt   = sum(1 for r in rows if r['amount'] == '0')
null_ccy   = sum(1 for r in rows if r['currency_code'] is None)
bad_ccy    = sum(1 for r in rows if r['currency_code'] in ('XXX','N/A','ZZZ'))
null_acc   = sum(1 for r in rows if r['account_number'] is None)
blank_acc  = sum(1 for r in rows if r['account_number'] == '')
null_cty   = sum(1 for r in rows if r['country_code'] is None)
bad_cty    = sum(1 for r in rows if r['country_code'] in ('XX','ZZ','QQ'))
bad_type   = sum(1 for r in rows if r['transaction_type'] in INVALID_TX_TYPES)

print(f'\nSeeded DQ issues ({N_ROWS} rows):')
print(f'  amount         — null: {null_amt}, negative: {neg_amt}, zero: {zero_amt}')
print(f'  currency_code  — null: {null_ccy}, invalid: {bad_ccy}')
print(f'  account_number — null: {null_acc}, blank: {blank_acc}')
print(f'  country_code   — null: {null_cty}, invalid: {bad_cty}')
print(f'  transaction_type — invalid: {bad_type}')

# ── Reference table: valid currency codes ──────────────────────────────────────
ref_rows = [{'currency_code': c, 'currency_name': c + ' Currency'} for c in VALID_CURRENCIES]

# ── BigQuery schemas ───────────────────────────────────────────────────────────
S = bigquery.SchemaField

TX_SCHEMA = [
    S('transaction_id',   'STRING'),
    S('line_of_business', 'STRING'),
    S('processing_date',  'STRING'),
    S('amount',           'STRING'),   # stored as STRING so nulls/invalids are preserved
    S('currency_code',    'STRING'),
    S('account_number',   'STRING'),
    S('transaction_type', 'STRING'),
    S('country_code',     'STRING'),
    S('reference_number', 'STRING'),
    S('status',           'STRING'),
    S('created_by',       'STRING'),
]

REF_SCHEMA = [
    S('currency_code', 'STRING'),
    S('currency_name', 'STRING'),
]

def load_table(name, data, schema):
    tid    = f'{PROJECT}.{DATASET}.{name}'
    table  = bigquery.Table(tid, schema=schema)
    table  = client.create_table(table, exists_ok=True)
    errors = client.insert_rows_json(table, data)
    if errors:
        print(f'  ✗ {name}: {errors[:2]}')
    else:
        print(f'  ✓ {name}: {len(data)} rows loaded')

# ── Create dataset & load ──────────────────────────────────────────────────────
ds = bigquery.Dataset(f'{PROJECT}.{DATASET}')
ds.location = LOCATION
client.create_dataset(ds, exists_ok=True)

print(f'\nLoading into {PROJECT}.{DATASET} ...')
load_table('camp_transactions',  rows,     TX_SCHEMA)
load_table('ref_currency_codes', ref_rows, REF_SCHEMA)

print(f"""
Done. Configure DQM with:

  Project ID   : {PROJECT}
  Dataset      : {DATASET}
  Table        : camp_transactions
  Group-by Col : line_of_business

Suggested PDEs to check:
  amount          — completeness + conformity (> 0) + specificity (0)
  currency_code   — completeness + reference (ref_currency_codes)
  account_number  — completeness
  country_code    — completeness + conformity (LENGTH = 2)
  transaction_type— completeness + conformity (IN allowed list)

Reference check:
  Table  : ref_currency_codes
  Column : currency_code
""")
