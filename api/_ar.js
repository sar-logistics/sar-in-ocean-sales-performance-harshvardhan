// ─────────────────────────────────────────────────────────────────
//  api/_ar.js  —  Accounts Receivable (customer outstanding)
//  Not a route (leading underscore): required by api/mongo-batch.js.
//
//  Source: the "Accounts Receivable" tab of the AR sheet (Logisys OS
//  report), pushed by the Apps Script in apps-script/arSync.gs as one
//  document per row that has a non-zero Outstanding (INR):
//    row with a Transaction No.    → an invoice
//    row without a Transaction No. → On Account (unmatched receipts, payments,
//                                    JVs, previous-year balances; either sign —
//                                    same as the sheet's "On Account Total")
//
//  A push arrives in chunks. Every chunk carries the same batchId; the
//  dashboard keeps reading the previous batch until the last chunk lands,
//  then switches over and the old batch is deleted — so a half-finished
//  push never shows partial numbers.
// ─────────────────────────────────────────────────────────────────

const AR_COLLECTION = "ar_outstanding";
const AR_META_ID = "ar_meta";
const AR_BUCKETS_ID = "ar_buckets"; // _meta doc: overdue bucket limits set by an admin

function normalizeName(name) {
  return String(name || "").split("|")[0].toLowerCase().replace(/\s+/g, " ").trim();
}
// The AR report sometimes ends a name with a stray dot ("Akash Vijay Naik.")
function arNameKey(name) {
  return normalizeName(name).replace(/\.+$/, "").trim();
}

// Dashboard LOB keys (same as the LOB filter): SEA/AIR/ISOTANK EXPORT/IMPORT,
// GENERAL for GEN invoices and rows with no LOB.
function arLobKey(lob, location) {
  const first = String(lob || "").split("\n")[0].trim().toUpperCase();
  if (String(location || "").trim().toLowerCase() === "iso tank") {
    return first.indexOf("IMPORT") > -1 ? "ISOTANK IMPORT" : "ISOTANK EXPORT";
  }
  if (["SEA EXPORT", "SEA IMPORT", "AIR EXPORT", "AIR IMPORT"].indexOf(first) > -1) return first;
  return "GENERAL";
}

// POST action=arPush  { batchId, rows:[...], first, last, asOn, source }
async function arPush(db, body) {
  const batchId = String(body.batchId || "").trim();
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!batchId) return { status: 400, json: { error: "batchId required" } };
  const col = db.collection(AR_COLLECTION);
  const metaCol = db.collection("_meta");

  if (body.first) {
    // Leftovers of an earlier push that never finished
    const meta = await metaCol.findOne({ _id: AR_META_ID });
    const keep = meta && meta.currentBatch;
    await col.deleteMany(keep ? { _batch: { $nin: [keep, batchId] } } : { _batch: { $ne: batchId } });
  }
  let inserted = 0;
  if (rows.length) {
    const now = new Date();
    const docs = rows.map((r) => ({ ...r, _batch: batchId, _insertedAt: now }));
    const res = await col.insertMany(docs, { ordered: false });
    inserted = res.insertedCount || 0;
  }
  if (body.last) {
    const count = await col.countDocuments({ _batch: batchId });
    await metaCol.updateOne(
      { _id: AR_META_ID },
      { $set: { currentBatch: batchId, asOn: body.asOn || null, source: body.source || null, count, pushedAt: new Date().toISOString() } },
      { upsert: true }
    );
    await col.deleteMany({ _batch: { $ne: batchId } });
    arCache = null;
    return { status: 200, json: { success: true, inserted, count, switched: true } };
  }
  return { status: 200, json: { success: true, inserted } };
}

// Sales person → { zone, display } from the Ocean mapping sheet, the same
// lookup the rest of the dashboard uses (FY27 row preferred; a zone of
// "Unassigned" doesn't count). Not on the mapping → zone "Cross Sales".
async function loadRepLookup(db) {
  let mappingRows = await db.collection("ocean_mapping_sales_targets").find({}).toArray();
  if (!mappingRows || mappingRows.length === 0) {
    mappingRows = await db.collection("mapping_sales_targets").find({}).toArray();
  }
  const byFy = { FY26: {}, FY27: {} };
  for (const row of mappingRows) {
    const norm = arNameKey(row["Sales Rep Name"]);
    if (!norm) continue;
    const fy = row._fy === "FY27" ? "FY27" : "FY26";
    byFy[fy][norm] = {
      zone: String(row["Zone"] || "Unassigned").trim(),
      display: String(row["Display Name"] || row["Sales Rep Name"] || "").trim(),
    };
  }
  return function (salesPerson) {
    const norm = arNameKey(salesPerson);
    const a = byFy.FY27[norm], b = byFy.FY26[norm];
    const hit = (a && a.zone && a.zone !== "Unassigned") ? a : (b && b.zone && b.zone !== "Unassigned") ? b : null;
    return hit ? { zone: hit.zone, display: hit.display || String(salesPerson || "").trim() } : null;
  };
}

// Turns pushed rows into the page payload. Columnar, with repeated strings
// replaced by an index into a dictionary, so ~25k rows stay well under the
// response size limit.
function buildArPayload(rows, repLookup, meta) {
  const dicts = { customer: [], sp: [], zone: [], lob: [], branch: [], location: [], type: [], gl: [] };
  const idx = {};
  Object.keys(dicts).forEach((k) => { idx[k] = new Map(); });
  function code(kind, value) {
    const v = String(value == null ? "" : value).trim();
    let i = idx[kind].get(v);
    if (i === undefined) { i = dicts[kind].length; dicts[kind].push(v); idx[kind].set(v, i); }
    return i;
  }
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  // "OVR Receivable" counts from arrival: base date = ATA, else ETA (else Trans. Date as in the report)
  // Dates arrive as "22-Sep-2026" (sync-formatted) or, for ETD/ETA/ATD/ATA, as the
  // sheet's text "22-09-2026" / "22/09/2026" (day-month-year)
  const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const ymd = (sv) => {
    const t = String(sv || "").trim();
    let m = /^(\d{1,2})[-\/ ]([A-Za-z]{3})[-\/ ](\d{4})$/.exec(t);
    if (m) { const mo = MON.indexOf(m[2].toLowerCase()); return mo < 0 ? null : [+m[3], mo, +m[1]]; }
    m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/.exec(t);
    if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) return [+m[3], +m[2] - 1, +m[1]];
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
    return m ? [+m[1], +m[2] - 1, +m[3]] : null;
  };
  const day = (sv) => { const d = ymd(sv); return d ? Date.UTC(d[0], d[1], d[2]) / 86400000 : null; };
  // → "22-Sep-2026", the format the page reads
  const fmt = (sv) => { const d = ymd(sv); if (!d) return ""; const M = MON[d[1]]; return ("0" + d[2]).slice(-2) + "-" + M[0].toUpperCase() + M.slice(1) + "-" + d[0]; };
  const asOnDay = day(meta && meta.asOn);

  // [customer, salesPerson(display), zone, lob, branch, location, type,
  //  txnNo, transDate, billAmt, outstanding, overdueDays, creditDays, houseNo, jobOwner,
  //  glGroup, baseDate (OVR Receivable: the ATA/ETA used instead of Trans. Date, else "")]
  // A sales person missing from the mapping keeps their report name, minus the "| INZ05" tag
  const out = [];
  // DSO totals (rows the sync marks _dso): [customer, sp, zone, lob, Σ bill, Σ bill × days, gl, Σ days, invoices]
  // The page shows the simple average: Σ days ÷ invoices
  const dso = [];
  for (const r of rows) {
    if (r._dso) {
      const rp = repLookup(r.salesPerson);
      dso.push([
        code("customer", r.customer),
        code("sp", rp ? rp.display : String(r.salesPerson || "").split("|")[0].replace(/\.+\s*$/, "").trim()),
        code("zone", rp ? rp.zone : "Cross Sales"),
        code("lob", arLobKey(r.lob, r.location)),
        num(r.dsoBill), num(r.dsoBillDays),
        code("gl", r.glGroup),
        num(r.dsoDays), num(r.dsoCount),
      ]);
      continue;
    }
    const o = num(r.outstanding);
    if (!o) continue;
    const rep = repLookup(r.salesPerson);
    const spName = rep ? rep.display : String(r.salesPerson || "").split("|")[0].replace(/\.+\s*$/, "").trim();
    let od = r.overdueDays;
    if (od === null || od === undefined || od === "") {
      od = (r.ageingDays !== null && r.ageingDays !== undefined && r.ageingDays !== "") ? num(r.ageingDays) - num(r.creditDays) : 0;
    }
    const gl = String(r["GL Group Name"] || "").trim();
    let baseDate = "";
    if (gl.toLowerCase() === "ovr receivable") {
      const ata = String(r.ATA || "").trim(), eta = String(r.eta || "").trim();
      baseDate = day(ata) !== null ? fmt(ata) : day(eta) !== null ? fmt(eta) : "";
      // Overdue days = Receipt Date (the "as on" date while nothing is received) − (ATA/ETA + Credit Days)
      const rcpt = day(r["Receipt Date"]);
      const endDay = rcpt !== null ? rcpt : asOnDay;
      if (baseDate && endDay !== null) od = endDay - day(baseDate) - num(r.creditDays);
    }
    out.push([
      code("customer", r.customer),
      code("sp", spName),
      code("zone", rep ? rep.zone : "Cross Sales"),
      code("lob", arLobKey(r.lob, r.location)),
      code("branch", r.branch),
      code("location", r.location),
      code("type", r.type),
      String(r.txnNo || ""),
      String(r.transDate || ""),
      num(r.billAmt),
      o,
      num(od),
      r.creditDays === null || r.creditDays === undefined || r.creditDays === "" ? null : num(r.creditDays),
      String(r.houseNo || ""),
      String(r.jobOwner || ""),
      code("gl", gl),
      baseDate,
    ]);
  }
  return {
    success: true,
    asOn: meta ? meta.asOn || null : null,
    pushedAt: meta ? meta.pushedAt || null : null,
    dicts,
    rows: out,
    dso,
  };
}

let arCache = null; // { key, data }

// GET action=ar
async function arGet(db, force, deployTs) {
  const meta = await db.collection("_meta").findOne({ _id: AR_META_ID });
  if (!meta || !meta.currentBatch) {
    return { success: true, asOn: null, pushedAt: null, dicts: null, rows: [], empty: true };
  }
  const key = meta.currentBatch + "|" + deployTs;
  if (!force && arCache && arCache.key === key) return arCache.data;
  const [rows, repLookup] = await Promise.all([
    db.collection(AR_COLLECTION).find({ _batch: meta.currentBatch }, { projection: { _id: 0, customer: 1, salesPerson: 1, lob: 1, location: 1, branch: 1, type: 1, txnNo: 1, transDate: 1, billAmt: 1, outstanding: 1, overdueDays: 1, ageingDays: 1, creditDays: 1, houseNo: 1, jobOwner: 1, _dso: 1, dsoBill: 1, dsoBillDays: 1, dsoDays: 1, dsoCount: 1, glGroup: 1, "GL Group Name": 1, ATA: 1, eta: 1, "Receipt Date": 1 } }).toArray(),
    loadRepLookup(db),
  ]);
  const data = buildArPayload(rows, repLookup, meta);
  arCache = { key, data };
  return data;
}

// Overdue slabs for everyone: edges = the ticked slabs' days ([15, 30] → 0-15, 15-30, 30+),
// slabs = all 9 rows as the admin left them ({ on, d }). null = page default.
async function arBucketsGet(db) {
  const doc = await db.collection("_meta").findOne({ _id: AR_BUCKETS_ID });
  return doc && Array.isArray(doc.edges)
    ? { edges: doc.edges, slabs: doc.slabs || null, updatedBy: doc.updatedBy || null, updatedAt: doc.updatedAt || null }
    : null;
}

function validEdges(e) {
  if (!Array.isArray(e) || e.length < 1 || e.length > 9) return false;
  for (let i = 0; i < e.length; i++) {
    if (!Number.isInteger(e[i]) || e[i] < 1 || e[i] > 3650) return false;
    if (i && e[i] <= e[i - 1]) return false;
  }
  return true;
}

// POST action=arBuckets { edges:[15, 30], slabs:[{ on, d } ×9], by }
async function arBucketsSave(db, body) {
  const edges = body && body.edges;
  if (!validEdges(edges)) return { status: 400, json: { success: false, error: "1 to 9 increasing whole numbers of days (1-3650) required" } };
  let slabs = body && body.slabs;
  const okSlabs = Array.isArray(slabs) && slabs.length === 9 &&
    slabs.every((x) => x && typeof x.on === "boolean" && Number.isInteger(x.d) && x.d >= 0 && x.d <= 3650) &&
    slabs.filter((x) => x.on).map((x) => x.d).join() === edges.join();
  if (!okSlabs) slabs = null;
  const doc = { edges, slabs, updatedBy: String((body && body.by) || "").slice(0, 120) || null, updatedAt: new Date().toISOString() };
  await db.collection("_meta").updateOne({ _id: AR_BUCKETS_ID }, { $set: doc }, { upsert: true });
  return { status: 200, json: { success: true, buckets: doc } };
}

// Detail-view columns: output key → stored field (mapped name, or the sheet
// header with dots removed, as the sync stores every column)
const AR_DETAIL_FIELDS = [
  ["ref", "refNo"],                 // Reference No.
  ["master", "Master No"],
  ["shipper", "shipper"],           // Shipper Name
  ["consignee", "Consignee Name"],
  ["custName", "Customer Name"],
  ["consol", "Consol No"],
  ["collExec", "collectionExec"],   // Collection Executive
  ["loadPort", "loadPort"],
  ["por", "Place Of Receipt"],
  ["dischargePort", "dischargePort"],
  ["pod", "Place Of Delivery"],
  ["etd", "etd"],
  ["eta", "eta"],
  ["atd", "ATD"],
  ["ata", "ATA"],
  ["refNo2", "Ref No"],             // Ref No.
  ["receiptDate", "Receipt Date"],
];

// action=arDetail → detail columns for some customers' lines.
// GET ?customer=… (one) or POST { customers:[…] } (a zone's worth, up to 2000).
// Rows: [customer, txnNo, houseNo, outstanding, ...AR_DETAIL_FIELDS values]
async function arDetail(db, customers) {
  const names = [...new Set((Array.isArray(customers) ? customers : [customers]).map((c) => String(c || "").trim()).filter(Boolean))];
  if (!names.length) return { status: 400, json: { success: false, error: "customer required" } };
  if (names.length > 2000) return { status: 400, json: { success: false, error: "too many customers" } };
  const fields = AR_DETAIL_FIELDS.map((f) => f[0]);
  const meta = await db.collection("_meta").findOne({ _id: AR_META_ID });
  if (!meta || !meta.currentBatch) return { status: 200, json: { success: true, fields, rows: [] } };
  const projection = { _id: 0, customer: 1, txnNo: 1, houseNo: 1, outstanding: 1 };
  AR_DETAIL_FIELDS.forEach((f) => { projection[f[1]] = 1; });
  const docs = await db.collection(AR_COLLECTION).find(
    { _batch: meta.currentBatch, customer: names.length === 1 ? names[0] : { $in: names } },
    { projection }
  ).toArray();
  const s = (v) => String(v == null ? "" : v).trim();
  const rows = docs.map((d) => [s(d.customer), s(d.txnNo), s(d.houseNo), Number(d.outstanding) || 0]
    .concat(AR_DETAIL_FIELDS.map((f) => s(d[f[1]]))));
  return { status: 200, json: { success: true, fields, rows } };
}

module.exports = { arPush, arGet, arBucketsGet, arBucketsSave, arDetail, buildArPayload, arLobKey, normalizeName };
