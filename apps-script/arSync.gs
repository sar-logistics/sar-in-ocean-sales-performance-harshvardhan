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
const AR_MAP_TAB = 'GL Type Org Mapping';   // Organization → GL Type (Overseas Agent / Sub Agent / Shipper / Vendor)
const AR_DEFAULT_API = 'https://sar-in-ocean-sales-performance.vercel.app/api/mongo-batch';
// Shown in the execution log, so it's easy to tell which copy of this script ran
const AR_SYNC_VERSION = '2026-11-24f (Logic tab start dates; writes the applied rule into the mapping Rule column; as-on from data; under Rs 1 settled; SEA+AIR = AIR; Incentive paid rows unchanged)';
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
  Logger.log('AR sync version ' + AR_SYNC_VERSION);
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
    const lob = col.lob > -1 ? arLob_(values[r][col.lob]).split(' / ')[0] : '';
    if (sp) u.sp[sp] = (u.sp[sp] || 0) + 1;
    if (lob) u.lob[lob] = (u.lob[lob] || 0) + 1;
  }
  const top = function (counts) {
    let best = '', n = 0;
    Object.keys(counts).forEach(function (k) { if (counts[k] > n) { n = counts[k]; best = k; } });
    return best;
  };

  const tz = Session.getScriptTimeZone();
  // Start date for ageing / DSO (AR sheet "Logic" tab) — see arStartDate_
  const orgType = arReadOrgTypes_(src);
  const hx = function (h) { return headers.indexOf(h); };
  const dIdx = { ATA: hx('ATA'), ETA: hx('ETA'), ATD: hx('ATD'), ETD: hx('ETD') };
  const glIdx = hx('GL Group Name');
  const asDate0 = function (v) { return v instanceof Date && !isNaN(v.getTime()) ? v : arParseDate_(v); };
  const startOf = function (row, lob, org) {
    const td = col.transDate > -1 ? asDate0(row[col.transDate]) : null;
    return arStartDate_(lob, glIdx > -1 ? row[glIdx] : '', org, orgType, td, function (k) { return dIdx[k] > -1 ? asDate0(row[dIdx[k]]) : null; });
  };
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
    if (doc.lob) doc.lob = arLob_(doc.lob);
    const u = usual[doc.customer];
    if (u && (!doc.salesPerson || !doc.lob)) {
      if (!doc.salesPerson) doc.salesPerson = top(u.sp);
      if (!doc.lob) doc.lob = top(u.lob);
      doc.inherited = true;
    }
    // invoices only (On Account lines have no Transaction No): the date ageing counts from
    if (doc.txnNo) {
      const st = startOf(row, doc.lob, org);
      doc.arStart = st.date ? Utilities.formatDate(st.date, tz, 'dd-MMM-yyyy') : '';
      doc.arStartKind = st.kind;
    }
    rows.push(doc);
    total += outstanding;
  }
  Logger.log('Read ' + (values.length - 1) + ' rows, ' + rows.length + ' with outstanding; net total ' + total.toFixed(2));

  const asOn = arAsOnDate_(src, values, col);

  // DSO (simple average), paid invoices included (per customer / rep / LOB / location / GL group). Per invoice: days =
  //   (the LAST Receipt Date — incl. the no-Organization receipt lines under the invoice —
  //    or the "as on" date while anything is still outstanding)
  //   − the start date (arStartDate_: Trans. Date, or ATA/ETA / ATD/ETD per the Logic tab)
  // Credit days are NOT taken off (they only decide Outstanding Due / Not Due); 0 if negative.
  // An invoice whose outstanding is negative (and nothing positive) is left out of DSO ("O/S < 0: Ignore").
  // Paid invoices have no outstanding so they aren't pushed as rows; instead one
  // small row per customer / sales person / LOB / location carries the totals
  // (_dso: true, outstanding 0 — pages that read outstanding rows skip it):
  //   dsoDays = Σ days, dsoCount = invoices → Average DSO = dsoDays ÷ dsoCount
  //   (dsoBill = Σ Bill Amount, dsoBillDays = Σ (Bill Amount × days) are still sent, not shown)
  const asOnDate = arParseDate_(asOn) || new Date();
  const rdCol = headers.indexOf('Receipt Date');
  // Paid invoices for the Incentive page keep the OLD rule (not part of the AR Logic tab change):
  // "OVR Receivable" (GL Group Name) counts from arrival: ATA, else ETA, else Trans. Date
  const glCol = headers.indexOf('GL Group Name'), ataCol = headers.indexOf('ATA'), etaCol = headers.indexOf('ETA');
  const ref2Col = headers.indexOf('Ref No.') > -1 ? headers.indexOf('Ref No.') : headers.indexOf('Ref No');
  const asDate = function (v) { return v instanceof Date && !isNaN(v.getTime()) ? v : arParseDate_(v); };
  const inv = {};
  let last = null; // the invoice on the line above, for follow-on receipt lines
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const org = String(row[col.customer] || '').trim();
    const txn = String(row[col.txnNo] || '').trim();
    if (!org && !txn) {
      // A line with no Organization right under an invoice is another receipt for that invoice
      // (e.g. the final settlement after a credit note). The invoice counts until its LAST receipt.
      const rd2 = last && rdCol > -1 ? asDate(row[rdCol]) : null;
      if (rd2 && (!last.rd || rd2 > last.rd)) last.rd = rd2;
      continue;
    }
    last = null;
    if (!org || !txn || org.toLowerCase() === 'total') continue;
    const bill = col.billAmt > -1 ? arNum_(row[col.billAmt]) : 0;
    const td = col.transDate > -1 ? row[col.transDate] : null;
    if (!(bill > 0) || !(td instanceof Date) || isNaN(td.getTime())) continue;
    const key = org + '\u0001' + txn;
    let x = inv[key];
    if (!x) {
      const u = usual[org] || { sp: {}, lob: {} };
      const gl = glCol > -1 ? String(row[glCol] || '').trim() : '';
      const oldBase = gl.toLowerCase() === 'ovr receivable'
        ? ((ataCol > -1 && asDate(row[ataCol])) || (etaCol > -1 && asDate(row[etaCol])) || td) : td;
      const lobV = (col.lob > -1 ? arLob_(row[col.lob]) : '') || top(u.lob);
      const st = startOf(row, lobV, org);
      x = inv[key] = {
        org: org, txn: txn, bill: bill, td: st.date || td, tdOld: oldBase, rd: null, open: false, neg: false, gl: gl,
        ref: [col.refNo > -1 ? row[col.refNo] : '', ref2Col > -1 ? row[ref2Col] : '']
          .map(function (v) { return String(v == null ? '' : v).trim(); }).filter(Boolean).join('\n'),
        cd: col.creditDays > -1 ? arNum_(row[col.creditDays]) : 0,
        sp: (col.salesPerson > -1 ? String(row[col.salesPerson] || '').trim() : '') || top(u.sp),
        lob: lobV,
        loc: col.location > -1 ? String(row[col.location] || '').trim() : '',
      };
    }
    const rd = rdCol > -1 ? asDate(row[rdCol]) : null;
    if (rd && (!x.rd || rd > x.rd)) x.rd = rd;
    const os = arNum_(row[col.outstanding]);
    if (os > 0) x.open = true;
    if (os >= 1) x.dsoOpen = true;   // less than ₹1 left counts as settled for DSO
    if (os <= -1) x.neg = true;
    last = x;
  }
  const dsoGroups = {};
  const paidRows = [];
  Object.keys(inv).forEach(function (k) {
    const x = inv[k];
    const end = x.dsoOpen || !x.rd ? asOnDate : x.rd;
    // days from invoice (OVR: arrival) to receipt — no credit days; a receipt before that date → 0
    const days = Math.max(0, Math.round((end.getTime() - x.td.getTime()) / 86400000));
    const oldDays = Math.max(0, Math.round((end.getTime() - x.tdOld.getTime()) / 86400000));   // Incentive page only
    // Incentive page: a fully paid invoice with its shipment Ref No, how many days it took to be paid, and how
    // many days overdue it was when paid = last Receipt Date − (Trans. Date + Credit Days); for OVR Receivable
    // the base is the arrival (ATA, else ETA, else Trans. Date) — the same rule as the AR page; 0 if paid on time
    // (_paid: true, outstanding 0 — pages that read outstanding rows skip it)
    if (!x.open && x.rd && x.ref) paidRows.push({ customer: x.org, txnNo: x.txn, refNo: x.ref, outstanding: 0, _paid: true, payDays: oldDays,
      creditDays: x.cd, paidOverdueDays: Math.max(0, Math.round((x.rd.getTime() - x.tdOld.getTime()) / 86400000) - (x.cd || 0)),
      receiptDate: Utilities.formatDate(x.rd, tz, 'dd-MMM-yyyy') });
    if (x.neg && !x.dsoOpen) return;   // Logic tab: O/S < 0 → ignore for DSO
    const gk = [x.org, x.sp, x.lob, x.loc, x.gl].join('\u0001');
    const g = dsoGroups[gk] || (dsoGroups[gk] = { customer: x.org, salesPerson: x.sp, lob: x.lob, location: x.loc, glGroup: x.gl,
      outstanding: 0, _dso: true, dsoBill: 0, dsoBillDays: 0, dsoDays: 0, dsoCount: 0 });
    g.dsoBill += x.bill; g.dsoBillDays += x.bill * days; g.dsoDays += days; g.dsoCount++;
  });
  const dsoRows = Object.keys(dsoGroups).map(function (k) { return dsoGroups[k]; });
  Logger.log('DSO: ' + Object.keys(inv).length + ' invoices in ' + dsoRows.length + ' customer/sales person/LOB groups');
  dsoRows.forEach(function (g) { rows.push(g); });
  Logger.log('Paid invoices with a Ref No (for the Incentive page): ' + paidRows.length);
  paidRows.forEach(function (x) { rows.push(x); });
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

// "02-Nov-2026", or the sheet's ETD/ETA/ATD/ATA text "22-09-2026" / "22/09/2026"
// (day-month-year) → Date (null when it can't be read)
function arParseDate_(s) {
  const t = String(s || '').trim();
  let m = /^(\d{1,2})[-\/ ]([A-Za-z]{3})[-\/ ](\d{4})$/.exec(t);
  if (m) {
    const mon = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[2].toLowerCase());
    return mon < 0 ? null : new Date(+m[3], mon, +m[1]);
  }
  m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/.exec(t);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
}

// Start date for ageing (Receipt/as-on − (start + Credit Days)) and DSO (Receipt/as-on − start),
// from the AR sheet's "Logic" tab (24-Nov-2026):
//   SEA EXPORT / SEA IMPORT: GL Group "OVR Receivable" AND the organization is in "GL Type Org Mapping" → ATA, else ETA
//   AIR EXPORT / AIR IMPORT: the organization is in "GL Type Org Mapping" as Overseas Agent / Sub Agent → ATD, else ETD
//   everything else (other LOBs, blank dates) → Trans. Date
// get(k) returns the row's 'ATA' / 'ETA' / 'ATD' / 'ETD' as a Date (or null). Returns { date, kind }.
function arStartDate_(lob, gl, org, orgType, transDate, get) {
  const L = String(lob || '').split(/\s*\n\s*|\s+\/\s+/)[0].trim().toUpperCase();
  const t = orgType[String(org || '').trim().toLowerCase()];
  if (/^SEA/.test(L) && String(gl || '').trim().toLowerCase() === 'ovr receivable' && t) {
    const ata = get('ATA'); if (ata) return { date: ata, kind: 'ATA' };
    const eta = get('ETA'); if (eta) return { date: eta, kind: 'ETA' };
  } else if (/^AIR/.test(L) && (t === 'overseas agent' || t === 'sub agent')) {
    const atd = get('ATD'); if (atd) return { date: atd, kind: 'ATD' };
    const etd = get('ETD'); if (etd) return { date: etd, kind: 'ETD' };
  }
  return { date: transDate, kind: 'Trans. Date' };
}

// "GL Type Org Mapping" tab → { organization (lower case): GL Type (lower case) }.
// Also fills its "Rule" column (user, 24-Nov-2026) with the Logic-tab rule this script applies to each
// organization, so it can be checked in the sheet - see arWriteOrgRules_. The Rule column is only written, never read.
function arReadOrgTypes_(src) {
  const out = {};
  const sh = src.getSheetByName(AR_MAP_TAB);
  if (!sh) { Logger.log('Tab "' + AR_MAP_TAB + '" not found - every invoice counts from Trans. Date'); return out; }
  const v = sh.getDataRange().getValues();
  const h = v[0].map(function (x) { return String(x).trim().toLowerCase(); });
  const oi = h.indexOf('organization'), ti = h.indexOf('gl type');
  if (oi < 0 || ti < 0) { Logger.log('"' + AR_MAP_TAB + '" needs Organization and GL Type columns'); return out; }
  for (let r = 1; r < v.length; r++) {
    const o = String(v[r][oi] || '').trim().toLowerCase();
    if (o) out[o] = String(v[r][ti] || '').trim().toLowerCase();
  }
  Logger.log(AR_MAP_TAB + ': ' + Object.keys(out).length + ' organizations');
  try { arWriteOrgRules_(src, sh, v, h.indexOf('rule'), oi, ti); }
  catch (e) { Logger.log('Rule column not written: ' + e.message); }   // never stops the sync
  return out;
}

// Rule column text per organization, from the Logic tab's "Ageing Condition" column (C5:C8):
//   Air: Overseas Agent / Sub Agent → C8 (ATD/ETD), other GL Types → C7 (Trans Date)
//   Sea: OVR Receivable invoices → C6 (ATA/ETA), other GL groups → C5 (Trans Date)
// Writes plain values, only the cells whose text changed.
function arWriteOrgRules_(src, sh, v, ri, oi, ti) {
  if (ri < 0) { Logger.log('"' + AR_MAP_TAB + '" has no Rule column - nothing written'); return; }
  const lg = src.getSheetByName('Logic');
  const c = lg ? lg.getRange('C5:C8').getDisplayValues().map(function (x) { return String(x[0] || '').trim(); }) : [];
  const seaOther = c[0] || 'Receipt Date - (Trans Date + Credit Days)';
  const seaOvr = c[1] || 'Receipt Date - (ATA/ETA + Credit Days)';
  const airOther = c[2] || 'Receipt Date - (Trans Date + Credit Days)';
  const airAgent = c[3] || 'Receipt Date - (ATD/ETD + Credit Days)';
  const out = [];
  let changed = 0;
  for (let r = 1; r < v.length; r++) {
    const o = String(v[r][oi] || '').trim();
    const t = String(v[r][ti] || '').trim().toLowerCase();
    const text = !o ? '' : 'Air: ' + (t === 'overseas agent' || t === 'sub agent' ? airAgent : airOther)
      + ' | Sea OVR Receivable: ' + seaOvr + ' | Sea other GL: ' + seaOther;
    if (String(v[r][ri] == null ? '' : v[r][ri]) !== text) changed++;
    out.push([text]);
  }
  if (changed && out.length) sh.getRange(2, ri + 1, out.length, 1).setValues(out);
  Logger.log('Rule column: ' + changed + ' of ' + out.length + ' rows updated' + (lg ? '' : ' (Logic tab not found, built-in text used)'));
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

// LOB cells sometimes repeat the same value on several lines ("AIR EXPORT\nAIR EXPORT");
// keep each value once so they group as one LOB
// A cell with both a SEA and an AIR LOB counts as AIR (user, 24-Nov-2026)
function arLob_(v) {
  const parts = String(v == null ? '' : v).split(/\s*\n\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
  const air = parts.filter(function (s) { return /^AIR/i.test(s); })[0];
  if (air && parts.some(function (s) { return /^SEA/i.test(s); })) return air;
  return parts.filter(function (s, i) { return parts.indexOf(s) === i; }).join(' / ');
}

// As-on date (24-Nov-2026): read from the AR data itself. The report counts Overdue Days up to its own
// as-on date, so on each open invoice Trans. Date + Credit Days + Overdue Days = that date; the most
// common answer wins. (The Summary tab title isn't always refreshed, and a fixed date goes stale.)
// AR_AS_ON_OVERRIDE: put a 'dd-MMM-yyyy' date here only to force one by hand.
const AR_AS_ON_OVERRIDE = '';

function arAsOnDate_(src, values, col) {
  if (AR_AS_ON_OVERRIDE) return AR_AS_ON_OVERRIDE;
  const tz = Session.getScriptTimeZone();
  if (values && col && col.transDate > -1 && col.creditDays > -1 && col.overdueDays > -1) {
    const count = {};
    let best = '', bestN = 0, n = 0;
    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      const td = row[col.transDate];
      if (!(td instanceof Date) || isNaN(td.getTime()) || !(arNum_(row[col.outstanding]) > 0)) continue;
      const cd = row[col.creditDays], od = row[col.overdueDays];
      if (String(cd == null ? '' : cd).trim() === '' || String(od == null ? '' : od).trim() === '') continue;
      const k = Utilities.formatDate(new Date(td.getFullYear(), td.getMonth(), td.getDate() + arNum_(cd) + arNum_(od)), tz, 'dd-MMM-yyyy');
      count[k] = (count[k] || 0) + 1; n++;
      if (count[k] > bestN) { bestN = count[k]; best = k; }
    }
    if (best && bestN >= n / 2) {
      Logger.log('As-on date from the data: ' + best + ' (' + bestN + ' of ' + n + ' open invoices agree)');
      return best;
    }
    Logger.log('As-on date: the data gives no clear answer (' + bestN + ' of ' + n + '), using the Summary tab title');
  }
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
