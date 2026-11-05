// ══════════════════════════════════════════════════════════════════════════
//  Accounts Receivable → Ocean Sales dashboard (page "Accounts Receivable")
// ══════════════════════════════════════════════════════════════════════════
//  Reads the "Accounts Receivable" tab of the AR sheet (read only) and pushes
//  every customer row with a non-zero Outstanding (INR) to /api/mongo-batch?action=arPush.
//  Rows without an Organization are the report's subtotal lines (e.g. the On
//  Account subtotal above each "Total") and are skipped, as are "Total" rows.
//    Outstanding > 0  → unpaid invoice
//    Outstanding < 0  → On Account (customer paid extra, held against the next bill)
//  The "as on" date is taken from the Summary tab's title ("... as on 02-Nov-2026").
//  On Account rows carry no Sales Person / LOB in the report, so they get the
//  customer's usual ones (most frequent across all of that customer's rows,
//  paid invoices included) and are flagged inherited: true.
//
//  Run:  pushArToDashboard()   (also safe to put on a daily time trigger)
//
//  Script Properties (Project Settings → Script properties), all optional:
//    AR_API_URL   default https://sar-in-ocean-sales-performance.vercel.app/api/mongo-batch
//                 (point it at the staging deployment to test there)
//    AR_BYPASS    Vercel "Protection Bypass for Automation" secret, only needed
//                 when AR_API_URL is a protected preview/staging deployment
// ══════════════════════════════════════════════════════════════════════════

const AR_SOURCE_ID = '1NQbaSffJzMZS6lNHjR6w7xQTCLQ_1X583b5PJ6bWcFI'; // Accounts Receivable sheet (read only)
const AR_TAB = 'Accounts Receivable';
const AR_SUMMARY_TAB = 'Ageing Receivable - Summary';
const AR_DEFAULT_API = 'https://sar-in-ocean-sales-performance.vercel.app/api/mongo-batch';
const AR_CHUNK = 1000; // every column goes up, so keep each request well under Vercel's 4.5 MB body limit

// sheet header → pushed field
const AR_FIELDS = {
  'Organization': 'customer',
  'Location': 'location',
  'Branch': 'branch',
  'Transaction No': 'txnNo',
  'Type': 'type',
  'Trans. Date': 'transDate',
  'Bill Amount (INR)': 'billAmt',
  'Outstanding (INR)': 'outstanding',
  'Overdue Days': 'overdueDays',
  'Ageing Days': 'ageingDays',
  'Credit Days': 'creditDays',
  'Sales Person': 'salesPerson',
  'Job Owner': 'jobOwner',
  'Collection Executive': 'collectionExec',
  'LOB': 'lob',
  'House No.': 'houseNo',
  'Invoice Currency': 'currency',
  // shipment details for the customer panel
  'Reference No.': 'refNo',
  'Shipper Name': 'shipper',
  'Load Port': 'loadPort',
  'Origin Port': 'originPort',
  'Discharge Port': 'dischargePort',
  'Dest Port': 'destPort',
  'ETD': 'etd',
  'ETA': 'eta',
};
const AR_NUMERIC = ['billAmt', 'outstanding', 'overdueDays', 'ageingDays', 'creditDays'];

function pushArToDashboard() {
  const t0 = Date.now();
  const src = SpreadsheetApp.openById(AR_SOURCE_ID);
  const sheet = src.getSheetByName(AR_TAB);
  if (!sheet) throw new Error('Tab "' + AR_TAB + '" not found');
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(function (h) { return String(h).trim(); });
  const col = {};
  Object.keys(AR_FIELDS).forEach(function (h) { col[AR_FIELDS[h]] = headers.indexOf(h); });
  ['customer', 'txnNo', 'outstanding'].forEach(function (k) {
    if (col[k] === -1) throw new Error('Column for "' + k + '" not found in ' + AR_TAB);
  });
  // Every other column is pushed too, under its sheet header (Mongo keys can't
  // hold "." or start with "$"; a repeated header gets " 2", " 3"…)
  const mappedIdx = {};
  Object.keys(col).forEach(function (k) { if (col[k] > -1) mappedIdx[col[k]] = true; });
  const extra = [], seen = {};
  Object.keys(AR_FIELDS).forEach(function (h) { seen[AR_FIELDS[h]] = true; });
  ['_batch', '_insertedAt', 'inherited'].forEach(function (k) { seen[k] = true; });
  headers.forEach(function (h, i) {
    if (!h || mappedIdx[i]) return;
    const base = h.replace(/\./g, '').replace(/^\$+/, '').trim();
    if (!base) return;
    let key = base, n = 1;
    while (seen[key]) key = base + ' ' + (++n);
    seen[key] = true;
    extra.push([key, i]);
  });

  // Customer → most frequent Sales Person / LOB (all rows, paid ones too)
  const usual = {};
  for (let r = 1; r < values.length; r++) {
    const org = String(values[r][col.customer] || '').trim();
    if (!org || org.toLowerCase() === 'total') continue;
    const u = usual[org] || (usual[org] = { sp: {}, lob: {} });
    const sp = col.salesPerson > -1 ? String(values[r][col.salesPerson] || '').trim() : '';
    const lob = col.lob > -1 ? String(values[r][col.lob] || '').split('\n')[0].trim() : '';
    if (sp) u.sp[sp] = (u.sp[sp] || 0) + 1;
    if (lob) u.lob[lob] = (u.lob[lob] || 0) + 1;
  }
  const top = function (counts) {
    let best = '', n = 0;
    Object.keys(counts).forEach(function (k) { if (counts[k] > n) { n = counts[k]; best = k; } });
    return best;
  };

  const tz = Session.getScriptTimeZone();
  const rows = [];
  let total = 0;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const org = String(row[col.customer] || '').trim();
    if (!org || org.toLowerCase() === 'total') continue;
    const outstanding = arNum_(row[col.outstanding]);
    if (!outstanding) continue;
    const doc = {};
    Object.keys(col).forEach(function (k) {
      if (col[k] === -1) { doc[k] = null; return; }
      const v = row[col[k]];
      if (AR_NUMERIC.indexOf(k) > -1) { doc[k] = String(v == null ? '' : v).trim() === '' ? null : arNum_(v); return; }
      if (v instanceof Date) { doc[k] = isNaN(v.getTime()) ? '' : Utilities.formatDate(v, tz, 'dd-MMM-yyyy'); return; }
      doc[k] = String(v == null ? '' : v).replace(/\s*\n\s*/g, '\n').trim();
    });
    extra.forEach(function (e) {
      const v = row[e[1]];
      if (v instanceof Date) { doc[e[0]] = isNaN(v.getTime()) ? '' : Utilities.formatDate(v, tz, 'dd-MMM-yyyy'); return; }
      doc[e[0]] = typeof v === 'number' ? v : String(v == null ? '' : v).replace(/\s*\n\s*/g, '\n').trim();
    });
    doc.customer = org;
    const u = usual[doc.customer];
    if (u && (!doc.salesPerson || !doc.lob)) {
      if (!doc.salesPerson) doc.salesPerson = top(u.sp);
      if (!doc.lob) doc.lob = top(u.lob);
      doc.inherited = true;
    }
    rows.push(doc);
    total += outstanding;
  }
  Logger.log('Read ' + (values.length - 1) + ' rows, ' + rows.length + ' with outstanding; net total ' + total.toFixed(2));

  const asOn = arAsOnDate_(src);
  const batchId = Utilities.getUuid();
  const chunks = Math.max(1, Math.ceil(rows.length / AR_CHUNK));
  for (let i = 0; i < chunks; i++) {
    const res = arPost_({
      action: 'arPush',
      batchId: batchId,
      rows: rows.slice(i * AR_CHUNK, (i + 1) * AR_CHUNK),
      first: i === 0,
      last: i === chunks - 1,
      asOn: asOn,
      source: src.getName(),
    });
    Logger.log('Chunk ' + (i + 1) + '/' + chunks + ': ' + JSON.stringify(res));
  }
  Logger.log('Done in ' + Math.round((Date.now() - t0) / 1000) + 's (as on ' + asOn + ')');
}

// "1,234.00", "(456.00)", " ", -456, "(1)" → number
function arNum_(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).trim();
  if (!s || s === '-') return 0;
  const neg = /^\(.*\)$/.test(s);
  const n = parseFloat(s.replace(/[(),\s]/g, ''));
  return isNaN(n) ? 0 : (neg ? -n : n);
}

function arAsOnDate_(src) {
  const sum = src.getSheetByName(AR_SUMMARY_TAB);
  const title = sum ? String(sum.getRange(1, 1).getDisplayValue() || '') : '';
  const m = title.match(/as on(?: date)?\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i);
  return m ? m[1] : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd-MMM-yyyy');
}

function arPost_(body) {
  const props = PropertiesService.getScriptProperties();
  let url = props.getProperty('AR_API_URL') || AR_DEFAULT_API;
  const headers = {};
  const bypass = props.getProperty('AR_BYPASS');
  if (bypass) {
    // Vercel accepts the bypass secret as a header or a query parameter; send both
    headers['x-vercel-protection-bypass'] = bypass;
    url += (url.indexOf('?') > -1 ? '&' : '?') + 'x-vercel-protection-bypass=' + encodeURIComponent(bypass);
  }
  const resp = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', headers: headers,
    payload: JSON.stringify(body), muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code !== 200) {
    // never echo the bypass secret back into the log
    const safe = text.replace(/x-vercel-protection-bypass(=|%3D)[^&"\s]*/gi, 'x-vercel-protection-bypass=***');
    throw new Error('arPush failed (' + code + '): ' + safe.slice(0, 300));
  }
  return JSON.parse(text);
}

// Prints which script properties are set and how long each value is (never the value itself)
function arCheckProps() {
  const p = PropertiesService.getScriptProperties().getProperties();
  Object.keys(p).forEach(function (k) {
    const v = p[k];
    Logger.log(JSON.stringify(k) + ' length ' + v.length + (v !== v.trim() ? ' (has spaces at the ends)' : '') + (/\u2022|\*/.test(v) ? ' (looks masked)' : ''));
  });
}
