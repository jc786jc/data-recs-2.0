"""
generate_test_data.py
─────────────────────
Creates two test tables in datarecsv2 for Data Reconciliation, TTCM, and Data Quality testing.

SOURCE TABLE  datarecsv2.source_data.src_transactions
  - 100K records (50K March 2026 + 50K April 2026)
  - Primary key: transaction_id
  - Columns: transaction_date, transaction_type_code, amount, currency, status, region
  - TTCM: transaction_type_codes change between March → April (5 deleted, 5 added, 5 changed)

TARGET TABLE  datarecsv2.target_data.tgt_transactions
  - 100K records (95K matching source PKs + 5K target-only)
  - 5K source records have NO match in target (SOURCE_ONLY exceptions)
  - ~5% of matched records have content differences (amount / status / currency)

Install:
  pip install google-cloud-bigquery

Run:
  gcloud auth application-default login
  python generate_test_data.py
"""

import random
import datetime
from google.cloud import bigquery

# ── CONFIG ────────────────────────────────────────────────────────────────────
PROJECT_A       = 'alpha-source-01'   # Source project
PROJECT_B       = 'beta-target-01'    # Target project
LOCATION        = 'US'
TOTAL_RECORDS   = 100_000
MATCH_RATE      = 0.95
SHARED_COUNT    = int(TOTAL_RECORDS * MATCH_RATE)   # 95,000
UNIQUE_SRC      = TOTAL_RECORDS - SHARED_COUNT       #  5,000 source-only
UNIQUE_TGT      = TOTAL_RECORDS - SHARED_COUNT       #  5,000 target-only

MONTHS = {
    'march': (datetime.date(2026, 3, 1), datetime.date(2026, 3, 31)),
    'april': (datetime.date(2026, 4, 1), datetime.date(2026, 4, 30)),
}

# Transaction type codes — change between March and April (for TTCM)
MARCH_CODES = [f'TC{str(i).zfill(3)}' for i in range(1, 26)]    # TC001–TC025  (25 codes)
APRIL_CODES = [f'TC{str(i).zfill(3)}' for i in range(1, 21)]    # TC001–TC020  kept
APRIL_CODES += [f'TC{str(i).zfill(3)}' for i in range(26, 31)]  # TC026–TC030  new (5 added)
# TC021–TC025 deleted in April → 5 deleted, 5 added = 10 TTCM changes

CURRENCIES  = ['USD', 'GBP', 'EUR', 'INR', 'AUD', 'SGD']
STATUSES    = ['SETTLED', 'PENDING', 'FAILED', 'REVERSED', 'PROCESSING']
REGIONS     = ['UK', 'US', 'EU', 'APAC', 'LATAM']
# ─────────────────────────────────────────────────────────────────────────────

client_a = bigquery.Client(project=PROJECT_A)
client_b = bigquery.Client(project=PROJECT_B)


def rnd_date(month_key):
    start, end = MONTHS[month_key]
    delta = (end - start).days
    return start + datetime.timedelta(days=random.randint(0, delta))


def rnd_txn_code(month_key):
    codes = MARCH_CODES if month_key == 'march' else APRIL_CODES
    return random.choice(codes)


def build_source_rows():
    """100K source rows — 50K March + 50K April."""
    print('  Building source rows...')
    rows = []
    half = TOTAL_RECORDS // 2

    for i in range(TOTAL_RECORDS):
        month = 'march' if i < half else 'april'
        txn_id = f'SRC-{str(i + 1).zfill(8)}'
        rows.append({
            'transaction_id':        txn_id,
            'transaction_date':      rnd_date(month).isoformat(),
            'transaction_type_code': rnd_txn_code(month),
            'amount':                round(random.uniform(10.0, 99999.99), 2),
            'currency':              random.choice(CURRENCIES),
            'status':                random.choice(STATUSES),
            'region':                random.choice(REGIONS),
        })
    return rows


def build_target_rows(source_rows):
    """
    95K rows matching source PKs (with some content differences)
    + 5K target-only rows (TARGET_ONLY exceptions)
    """
    print('  Building target rows...')

    # Pick 95K shared from source (skip the last 5K → those become SOURCE_ONLY)
    shared_src = source_rows[:SHARED_COUNT]

    target_rows = []

    for src in shared_src:
        amt      = src['amount']
        currency = src['currency']
        status   = src['status']
        code     = src['transaction_type_code']

        # ~5% amount variance
        if random.random() < 0.05:
            amt = round(amt + random.uniform(-500, 500), 2)

        # ~2% currency mismatch
        if random.random() < 0.02:
            currency = random.choice([c for c in CURRENCIES if c != currency])

        # ~3% status mismatch
        if random.random() < 0.03:
            status = random.choice([s for s in STATUSES if s != status])

        target_rows.append({
            'transaction_id':        src['transaction_id'],
            'transaction_date':      src['transaction_date'],
            'transaction_type_code': code,
            'amount':                amt,
            'currency':              currency,
            'status':                status,
            'region':                src['region'],
        })

    # 5K target-only rows (TARGET_ONLY)
    for i in range(UNIQUE_TGT):
        month = random.choice(['march', 'april'])
        txn_id = f'TGT-{str(i + 1).zfill(8)}'
        target_rows.append({
            'transaction_id':        txn_id,
            'transaction_date':      rnd_date(month).isoformat(),
            'transaction_type_code': rnd_txn_code(month),
            'amount':                round(random.uniform(10.0, 99999.99), 2),
            'currency':              random.choice(CURRENCIES),
            'status':                random.choice(STATUSES),
            'region':                random.choice(REGIONS),
        })

    random.shuffle(target_rows)
    return target_rows


def ensure_dataset(bq_client, project, dataset_id):
    ref = bigquery.Dataset(f'{project}.{dataset_id}')
    ref.location = LOCATION
    bq_client.create_dataset(ref, exists_ok=True)
    print(f'  Dataset ready: {project}.{dataset_id}')


def load_rows(bq_client, project, dataset_id, table_id, rows):
    table_ref  = f'{project}.{dataset_id}.{table_id}'
    job_config = bigquery.LoadJobConfig(
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        autodetect=True,
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
    )
    print(f'  Loading {len(rows):,} rows → {table_ref} ...')
    job = bq_client.load_table_from_json(rows, table_ref, job_config=job_config)
    job.result()
    tbl = bq_client.get_table(table_ref)
    print(f'  ✓ {tbl.num_rows:,} rows loaded into {table_ref}')


def print_summary(source_rows, target_rows):
    shared_ids     = {r['transaction_id'] for r in source_rows[:SHARED_COUNT]}
    tgt_ids        = {r['transaction_id'] for r in target_rows}
    matched        = shared_ids & tgt_ids
    source_only    = {r['transaction_id'] for r in source_rows} - tgt_ids
    target_only    = tgt_ids - {r['transaction_id'] for r in source_rows}

    print()
    print('=' * 65)
    print('SUMMARY')
    print('=' * 65)
    print(f'Source table : {PROJECT_A}.source_data.src_transactions')
    print(f'  Total rows : {len(source_rows):,}')
    print(f'  March 2026 : {sum(1 for r in source_rows if r["transaction_date"] < "2026-04-01"):,} rows')
    print(f'  April 2026 : {sum(1 for r in source_rows if r["transaction_date"] >= "2026-04-01"):,} rows')
    print(f'  Columns    : transaction_id, transaction_date, transaction_type_code,')
    print(f'               amount, currency, status, region')
    print()
    print(f'Target table : {PROJECT_B}.target_data.tgt_transactions')
    print(f'  Total rows : {len(target_rows):,}')
    print()
    print('RECONCILIATION STATS (expected)')
    print(f'  Matched      : {len(matched):,}  ({len(matched)/len(source_rows)*100:.1f}%)')
    print(f'  Source Only  : {len(source_only):,}  (in source, not in target)')
    print(f'  Target Only  : {len(target_only):,}  (in target, not in source)')
    print()
    print('CONTENT DIFFERENCES (approx, in matched records)')
    print(f'  Amount variance  : ~{int(SHARED_COUNT * 0.05):,} rows  (5%)')
    print(f'  Currency mismatch: ~{int(SHARED_COUNT * 0.02):,} rows  (2%)')
    print(f'  Status mismatch  : ~{int(SHARED_COUNT * 0.03):,} rows  (3%)')
    print()
    print('TTCM (Transaction Type Code changes March → April)')
    march_set = set(MARCH_CODES)
    april_set = set(APRIL_CODES)
    print(f'  March codes : {len(march_set)} codes  ({", ".join(sorted(march_set)[:5])}...)')
    print(f'  April codes : {len(april_set)} codes  ({", ".join(sorted(april_set)[:5])}...)')
    print(f'  Deleted     : {sorted(march_set - april_set)}')
    print(f'  Added       : {sorted(april_set - march_set)}')
    print('=' * 65)


def main():
    print('=' * 65)
    print('Data Recs 2.0 — Test Data Generator')
    print('=' * 65)

    print('\n[1/5] Generating source rows...')
    source_rows = build_source_rows()

    print('\n[2/5] Generating target rows...')
    target_rows = build_target_rows(source_rows)

    print('\n[3/5] Creating BigQuery datasets...')
    ensure_dataset(client_a, PROJECT_A, 'source_data')
    ensure_dataset(client_b, PROJECT_B, 'target_data')

    print('\n[4/5] Loading tables...')
    load_rows(client_a, PROJECT_A, 'source_data', 'src_transactions', source_rows)
    load_rows(client_b, PROJECT_B, 'target_data', 'tgt_transactions', target_rows)

    print('\n[5/5] Done!')
    print_summary(source_rows, target_rows)


if __name__ == '__main__':
    main()
