/**
 * qvd.js — QVD (QlikView Data) binary file writer
 * Compatible with Qlik Sense and QlikView.
 *
 * File layout: [XML header bytes][0x00][bit-packed binary data]
 *
 * Each field gets a symbol table of unique sorted string values.
 * Row data encodes each cell as a symbol-table index, bit-packed LSB-first
 * with bias=-1 (stored 0 = null, stored 1 = sym[0], stored N = sym[N-1]).
 */

/* ── PUBLIC ──────────────────────────────────────────────────────── */

/**
 * Called from the Export QVD button after reconciliation completes.
 * Exports detailed rows in demo mode, or a summary stats row in real mode.
 */
function exportQVD() {
  let cols, rows, tableName;

  const srcTable = getVal('proj-a-table') || 'source';
  const tgtTable = getVal('proj-b-table') || 'target';

  if (state.recRows && state.recRows.length) {
    // Demo mode — export full detail table (rec_status, amounts, variance)
    cols      = state.recCols;
    rows      = state.recRows;
    tableName = `TallyRec_${srcTable}_vs_${tgtTable}`;

  } else if (state.matchedCount > 0 || state.unmatchedCount > 0) {
    // Real mode — export one summary stats row per run
    const now      = new Date();
    const runDate  = now.toISOString().split('T')[0];
    const runTs    = now.toISOString().replace('T', ' ').substring(0, 19);
    const matchPct = state.srcCount > 0
      ? ((state.matchedCount / state.srcCount) * 100).toFixed(2)
      : '0.00';

    cols = [
      'RunDate', 'RunTimestamp',
      'SourceProject', 'SourceDataset', 'SourceTable', 'SourceDescription',
      'TargetProject',  'TargetDataset',  'TargetTable',  'TargetDescription',
      'MatchedCount', 'UnmatchedCount', 'SourceTotal', 'TargetTotal', 'MatchRatePct',
    ];
    rows = [{
      RunDate:           runDate,
      RunTimestamp:      runTs,
      SourceProject:     getVal('proj-a-id'),
      SourceDataset:     getVal('proj-a-dataset'),
      SourceTable:       srcTable,
      SourceDescription: getVal('proj-a-desc') || srcTable,
      TargetProject:     getVal('proj-b-id'),
      TargetDataset:     getVal('proj-b-dataset'),
      TargetTable:       tgtTable,
      TargetDescription: getVal('proj-b-desc') || tgtTable,
      MatchedCount:      String(state.matchedCount),
      UnmatchedCount:    String(state.unmatchedCount),
      SourceTotal:       String(state.srcCount),
      TargetTotal:       String(state.tgtCount),
      MatchRatePct:      matchPct,
    }];
    tableName = `TallyRecSummary_${srcTable}_vs_${tgtTable}`;

  } else {
    showToast('Run reconciliation first before exporting.', 'warn');
    return;
  }

  try {
    const bytes    = _buildQVD(cols, rows, tableName);
    const filename = `${tableName}_${new Date().toISOString().split('T')[0]}.qvd`;
    _triggerDownload(bytes, filename);
    showToast(`QVD exported — load in Qlik Sense Data Manager: ${filename}`, 'success');
  } catch (e) {
    showToast(`QVD export failed: ${e.message}`, 'error');
    console.error('[QVD]', e);
  }
}

/* ── CORE: Binary QVD builder ────────────────────────────────────── */

function _buildQVD(cols, rows, tableName) {
  const utcTime = new Date().toISOString()
    .replace('T', ' ').substring(0, 19).replace(/-/g, '/');

  // ── 1. Symbol tables: sorted unique string values per column ─────
  const symTables = cols.map(col => {
    const seen = new Set();
    rows.forEach(r => {
      const v = r[col];
      if (v !== null && v !== undefined && v !== '') seen.add(String(v));
    });
    return Array.from(seen).sort();
  });

  // ── 2. Bit layout ─────────────────────────────────────────────────
  // bias=-1: stored_value = symIndex + 1  (0 = null)
  // max stored = symCount → need ceil(log2(symCount + 1)) bits, min 1
  const bitWidths  = symTables.map(s =>
    s.length === 0 ? 1 : Math.max(1, Math.ceil(Math.log2(s.length + 1)))
  );
  const bitOffsets = [];
  let   bitCursor  = 0;
  bitWidths.forEach(bw => { bitOffsets.push(bitCursor); bitCursor += bw; });
  const recordByteSize = Math.max(1, Math.ceil(bitCursor / 8));

  // ── 3. Binary data (bit-packed, LSB-first within each byte) ──────
  const binData = new Uint8Array(rows.length * recordByteSize);
  rows.forEach((row, ri) => {
    const base = ri * recordByteSize;
    cols.forEach((col, ci) => {
      const raw    = row[col];
      const syms   = symTables[ci];
      const symIdx = (raw === null || raw === undefined || raw === '')
        ? -1 : syms.indexOf(String(raw));
      const stored = symIdx + 1;       // bias offset; 0 = null
      const bitOff = bitOffsets[ci];
      const bitW   = bitWidths[ci];
      for (let b = 0; b < bitW; b++) {
        if ((stored >> b) & 1) {
          binData[base + Math.floor((bitOff + b) / 8)] |= 1 << ((bitOff + b) % 8);
        }
      }
    });
  });

  // ── 4. XML header ──────────────────────────────────────────────────
  const x = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const fieldsXml = cols.map((col, i) => {
    const symXml = symTables[i]
      .map(v => `<Symbols><Type>S</Type><String>${x(v)}</String></Symbols>`)
      .join('');
    return `<QvdFieldHeader>` +
      `<FieldName>${x(col)}</FieldName>` +
      `<BitOffset>${bitOffsets[i]}</BitOffset>` +
      `<BitWidth>${bitWidths[i]}</BitWidth>` +
      `<Bias>-1</Bias>` +
      `<NoOfSymbols>${symTables[i].length}</NoOfSymbols>` +
      `<SymbolTable>${symXml}</SymbolTable>` +
      `</QvdFieldHeader>`;
  }).join('');

  const enc    = new TextEncoder();
  const length = binData.length;   // byte size of binary section

  // Offset = byte position where binary section starts = xmlBytes.length + 1 (null byte)
  // Problem: Offset is inside the XML, so including it changes XML length.
  // Three-pass approach guarantees the value stabilises (digit-count won't change twice).
  const makeXml = off =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<QvdTableHeader>\n` +
    `<QvdVersion>12.00.0.0</QvdVersion>\n` +
    `<CreateUtcTime>${utcTime}</CreateUtcTime>\n` +
    `<Heading>${x(tableName)}</Heading>\n` +
    `<TableName>${x(tableName)}</TableName>\n` +
    `<Fields>${fieldsXml}</Fields>\n` +
    `<NoOfRecords>${rows.length}</NoOfRecords>\n` +
    `<RecordByteSize>${recordByteSize}</RecordByteSize>\n` +
    `<HasExpansion>false</HasExpansion>\n` +
    `<Offset>${off}</Offset>\n` +
    `<Length>${length}</Length>\n` +
    `</QvdTableHeader>\n`;

  let xmlBytes = enc.encode(makeXml(0));
  let offset   = xmlBytes.length + 1;
  xmlBytes     = enc.encode(makeXml(offset));
  offset       = xmlBytes.length + 1;
  xmlBytes     = enc.encode(makeXml(offset));  // third pass: stable

  // ── 5. Assemble: XML + null byte + binary ─────────────────────────
  const out = new Uint8Array(xmlBytes.length + 1 + binData.length);
  out.set(xmlBytes);
  out[xmlBytes.length] = 0x00;
  out.set(binData, xmlBytes.length + 1);
  return out;
}

/* ── Helper ──────────────────────────────────────────────────────── */

function _triggerDownload(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
