"""
generate_ttcm_test_data.py — TTCM Test Data Generator

Creates 4 BigQuery tables in datarecsv2.ttcm_data:
  sscrtyp_prev / sscrtyp_cur  (ML15 — Transaction Type Codes)
  sscrcep_prev / sscrcep_cur  (ML16 — HUB→CAMP Mappings)

Changes seeded between PREV and CUR:
  ML15: 20 deleted, 20 added, 40 attribute changes
  ML16: 30 deleted, 40 added, 50 mapping changes

Usage:
    pip install google-cloud-bigquery
    python generate_ttcm_test_data.py
"""

import random
import string

try:
    from google.cloud import bigquery
except ImportError:
    print('ERROR: Run   pip install google-cloud-bigquery   then retry.')
    raise

PROJECT  = 'datarecsv2'
DATASET  = 'ttcm_data'
LOCATION = 'US'

client = bigquery.Client(project=PROJECT)

random.seed(42)

# ── Value pools ────────────────────────────────────────────────────────────────
ACTIVITY_TYPES = ['CR', 'DB', 'E', 'IC', 'M', 'W']
YES_NO         = ['Y', 'N']
SUBSYS_CODES   = ['DD', 'OR', 'IR', 'IB', 'HE', 'SE', 'FX', 'MM']
DEAL_CODES     = ['DD', 'TT', 'TTI', 'FTR', 'CO', 'SWP', 'OPT', 'FWD']
INPUT_MEDIUM   = ['N', 'P', 'V', 'I', 'H', 'B']

def ps_id():
    return str(random.randint(100000, 999999))

def rand_date():
    return f'2025{random.randint(1,12):02d}{random.randint(1,28):02d}'

# ── ML15: SSCRTYP ──────────────────────────────────────────────────────────────

def gen_code():
    return random.choice('CD') + ''.join(random.choices(string.ascii_uppercase, k=3))

def make_sscrtyp(code, overrides=None):
    cr = code[0]
    act_pool = ['CR','E','IC','M','W'] if cr == 'C' else ['DB','E','IC','M','W']
    rec = {
        'cyttyo':         code,
        'cyttsn':         f'{code[:2]}-{code[2:]}',
        'cyttna':         f'{code} TRANSACTION TYPE',
        'cydcin':         cr,
        'cypraf':         random.choice(YES_NO),
        'cyatvt':         random.choice(act_pool),
        'cydlup':         rand_date(),
        'cytlup':         ps_id(),
        'people_soft_id': ps_id(),
    }
    if overrides:
        rec.update(overrides)
    return rec

# Generate 500 unique codes
codes = set()
while len(codes) < 500:
    codes.add(gen_code())
codes = list(codes)

deleted_codes = set(random.sample(codes, 20))
changed_codes = set(random.sample([c for c in codes if c not in deleted_codes], 40))

new_codes = set()
while len(new_codes) < 20:
    c = gen_code()
    if c not in codes and c not in new_codes:
        new_codes.add(c)

sscrtyp_prev = [make_sscrtyp(c) for c in codes]
prev_ml15    = {r['cyttyo']: r for r in sscrtyp_prev}

sscrtyp_cur = []
for code in codes:
    if code in deleted_codes:
        continue
    if code in changed_codes:
        base = dict(prev_ml15[code])
        fields = random.sample(['cyttna', 'cydcin', 'cypraf', 'cyatvt'], k=random.randint(1, 3))
        ovr = {'cydlup': rand_date(), 'people_soft_id': ps_id()}
        for f in fields:
            if f == 'cyttna':  ovr['cyttna'] = f'{code} UPDATED TYPE'
            elif f == 'cydcin': ovr['cydcin'] = 'D' if base['cydcin'] == 'C' else 'C'
            elif f == 'cypraf': ovr['cypraf'] = 'N' if base['cypraf'] == 'Y' else 'Y'
            elif f == 'cyatvt': ovr['cyatvt'] = random.choice([a for a in ACTIVITY_TYPES if a != base['cyatvt']])
        sscrtyp_cur.append(make_sscrtyp(code, ovr))
    else:
        sscrtyp_cur.append(dict(prev_ml15[code]))

for c in new_codes:
    sscrtyp_cur.append(make_sscrtyp(c))

print(f'ML15  PREV={len(sscrtyp_prev)}  CUR={len(sscrtyp_cur)}')
print(f'      Deleted={len(deleted_codes)}  Added={len(new_codes)}  Changed={len(changed_codes)}')

# ── ML16: SSCRCEP ──────────────────────────────────────────────────────────────

sys_codes = list({str(random.randint(10000, 99999)) for _ in range(150)})[:100]
valid_ttc = [c for c in codes if len(c) == 4]

def make_sscrcep(cztcoe, cztcoz, czsscd, czdlcd, czimty, overrides=None):
    rec = {
        'cztcoe':         cztcoe,
        'cztcoz':         cztcoz,
        'czsscd':         czsscd,
        'czdlcd':         czdlcd,
        'czimty':         czimty,
        'cztmof':         random.choice(['Y', 'N']),
        'czttyo':         random.choice(valid_ttc),
        'czatvt':         random.choice(ACTIVITY_TYPES),
        'czdlup':         rand_date(),
        'cztlup':         ps_id(),
        'people_soft_id': ps_id(),
    }
    if overrides:
        rec.update(overrides)
    return rec

used_keys  = set()
sscrcep_prev = []
while len(sscrcep_prev) < 800:
    coe  = random.choice(sys_codes)
    coz  = coe
    sscd = random.choice(SUBSYS_CODES)
    dlcd = random.choice(DEAL_CODES)
    imty = random.choice(INPUT_MEDIUM)
    key  = (coe, coz, sscd, dlcd, imty)
    if key not in used_keys:
        used_keys.add(key)
        sscrcep_prev.append(make_sscrcep(*key))

n       = len(sscrcep_prev)
del_idx = set(random.sample(range(n), 30))
chg_idx = set(random.sample([i for i in range(n) if i not in del_idx], 50))

new_maps = []
while len(new_maps) < 40:
    coe  = random.choice(sys_codes)
    coz  = coe
    sscd = random.choice(SUBSYS_CODES)
    dlcd = random.choice(DEAL_CODES)
    imty = random.choice(INPUT_MEDIUM)
    key  = (coe, coz, sscd, dlcd, imty)
    if key not in used_keys:
        used_keys.add(key)
        new_maps.append(make_sscrcep(*key))

sscrcep_cur = []
for i, rec in enumerate(sscrcep_prev):
    if i in del_idx:
        continue
    if i in chg_idx:
        fields = random.sample(['cztmof', 'czttyo', 'czatvt'], k=random.randint(1, 2))
        ovr = {'czdlup': rand_date(), 'people_soft_id': ps_id()}
        for f in fields:
            if f == 'cztmof': ovr['cztmof'] = 'N' if rec['cztmof'] == 'Y' else 'Y'
            elif f == 'czttyo': ovr['czttyo'] = random.choice([c for c in valid_ttc if c != rec['czttyo']])
            elif f == 'czatvt': ovr['czatvt'] = random.choice([a for a in ACTIVITY_TYPES if a != rec['czatvt']])
        r = dict(rec)
        r.update(ovr)
        sscrcep_cur.append(r)
    else:
        sscrcep_cur.append(dict(rec))

sscrcep_cur.extend(new_maps)

print(f'ML16  PREV={len(sscrcep_prev)}  CUR={len(sscrcep_cur)}')
print(f'      Deleted={len(del_idx)}  Added={len(new_maps)}  Changed={len(chg_idx)}')

# ── BigQuery schemas ───────────────────────────────────────────────────────────

S = bigquery.SchemaField

SSCRTYP_SCHEMA = [
    S('cyttyo','STRING'), S('cyttsn','STRING'), S('cyttna','STRING'),
    S('cydcin','STRING'), S('cypraf','STRING'), S('cyatvt','STRING'),
    S('cydlup','STRING'), S('cytlup','STRING'), S('people_soft_id','STRING'),
]

SSCRCEP_SCHEMA = [
    S('cztcoe','STRING'), S('cztcoz','STRING'), S('czsscd','STRING'),
    S('czdlcd','STRING'), S('czimty','STRING'), S('cztmof','STRING'),
    S('czttyo','STRING'), S('czatvt','STRING'), S('czdlup','STRING'),
    S('cztlup','STRING'), S('people_soft_id','STRING'),
]

def load_table(name, rows, schema):
    tid    = f'{PROJECT}.{DATASET}.{name}'
    table  = bigquery.Table(tid, schema=schema)
    table  = client.create_table(table, exists_ok=True)
    errors = client.insert_rows_json(table, rows)
    if errors:
        print(f'  ✗ {name}: {errors[:2]}')
    else:
        print(f'  ✓ {name}: {len(rows)} rows loaded')

# Create dataset
ds = bigquery.Dataset(f'{PROJECT}.{DATASET}')
ds.location = LOCATION
client.create_dataset(ds, exists_ok=True)

print(f'\nLoading into {PROJECT}.{DATASET} ...')
load_table('sscrtyp_prev', sscrtyp_prev, SSCRTYP_SCHEMA)
load_table('sscrtyp_cur',  sscrtyp_cur,  SSCRTYP_SCHEMA)
load_table('sscrcep_prev', sscrcep_prev, SSCRCEP_SCHEMA)
load_table('sscrcep_cur',  sscrcep_cur,  SSCRCEP_SCHEMA)

print(f"""
Done. Configure TTCM with:
  Project ID : {PROJECT}
  Dataset    : {DATASET}
  Location   : {LOCATION}
  ML15 Prev  : sscrtyp_prev
  ML15 Cur   : sscrtyp_cur
  ML16 Prev  : sscrcep_prev
  ML16 Cur   : sscrcep_cur
""")
