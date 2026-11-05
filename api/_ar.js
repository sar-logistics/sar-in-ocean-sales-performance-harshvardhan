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
  const dicts = { customer: [], sp: [], zone: [], lob: [], branch: [], location: [], type: [] };
  const idx = {};
  Object.keys(dicts).forEach((k) => { idx[k] = new Map(); });
  function code(kind, value) {
    const v = String(value == null ? "" : value).trim();
    let i = idx[kind].get(v);
    if (i === undefined) { i = dicts[kind].length; dicts[kind].push(v); idx[kind].set(v, i); }
    return i;
  }
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

  // [customer, salesPerson(display), zone, lob, branch, location, type,
  //  txnNo, transDate, billAmt, outstanding, overdueDays, creditDays, houseNo, jobOwner]
  // A sales person missing from the mapping keeps their report name, minus the "| INZ05" tag
  const out = [];
  for (const r of rows) {
    const o = num(r.outstanding);
    if (!o) continue;
    const rep = repLookup(r.salesPerson);
    const spName = rep ? rep.display : String(r.salesPerson || "").split("|")[0].replace(/\.+\s*$/, "").trim();
    let od = r.overdueDays;
    if (od === null || od === undefined || od === "") {
      od = (r.ageingDays !== null && r.ageingDays !== undefined && r.ageingDays !== "") ? num(r.ageingDays) - num(r.creditDays) : 0;
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
    ]);
  }
  return {
    success: true,
    asOn: meta ? meta.asOn || null : null,
    pushedAt: meta ? meta.pushedAt || null : null,
    dicts,
    rows: out,
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
    db.collection(AR_COLLECTION).find({ _batch: meta.currentBatch }, { projection: { _id: 0, customer: 1, salesPerson: 1, lob: 1, location: 1, branch: 1, type: 1, txnNo: 1, transDate: 1, billAmt: 1, outstanding: 1, overdueDays: 1, ageingDays: 1, creditDays: 1, houseNo: 1, jobOwner: 1 } }).toArray(),
    loadRepLookup(db),
  ]);
  const data = buildArPayload(rows, repLookup, meta);
  arCache = { key, data };
  return data;
}

// Overdue bucket limits for everyone ([30, 60, 90, 120] → 0-30 … 120+); null = page default
async function arBucketsGet(db) {
  const doc = await db.collection("_meta").findOne({ _id: AR_BUCKETS_ID });
  return doc && Array.isArray(doc.edges) ? { edges: doc.edges, updatedBy: doc.updatedBy || null, updatedAt: doc.updatedAt || null } : null;
}

function validEdges(e) {
  if (!Array.isArray(e) || e.length < 1 || e.length > 8) return false;
  for (let i = 0; i < e.length; i++) {
    if (!Number.isInteger(e[i]) || e[i] < 1 || e[i] > 3650) return false;
    if (i && e[i] <= e[i - 1]) return false;
  }
  return true;
}

// POST action=arBuckets { edges:[30, 90], by }
async function arBucketsSave(db, body) {
  const edges = body && body.edges;
  if (!validEdges(edges)) return { status: 400, json: { success: false, error: "1 to 8 increasing whole numbers of days (1-3650) required" } };
  const doc = { edges, updatedBy: String((body && body.by) || "").slice(0, 120) || null, updatedAt: new Date().toISOString() };
  await db.collection("_meta").updateOne({ _id: AR_BUCKETS_ID }, { $set: doc }, { upsert: true });
  return { status: 200, json: { success: true, buckets: doc } };
}

// GET action=arDetail&customer=… → shipment details for one customer's lines:
// [txnNo, houseNo, outstanding, shipmentNo (Reference No.), shipper, POL, POD, ETD, ETA]
async function arDetail(db, customer) {
  const name = String(customer || "").trim();
  if (!name) return { status: 400, json: { success: false, error: "customer required" } };
  const meta = await db.collection("_meta").findOne({ _id: AR_META_ID });
  if (!meta || !meta.currentBatch) return { status: 200, json: { success: true, rows: [] } };
  const docs = await db.collection(AR_COLLECTION).find(
    { _batch: meta.currentBatch, customer: name },
    { projection: { _id: 0, txnNo: 1, houseNo: 1, outstanding: 1, refNo: 1, shipper: 1, loadPort: 1, originPort: 1, dischargePort: 1, destPort: 1, etd: 1, eta: 1 } }
  ).toArray();
  const s = (v) => String(v == null ? "" : v).trim();
  const rows = docs.map((d) => [
    s(d.txnNo), s(d.houseNo), Number(d.outstanding) || 0,
    s(d.refNo), s(d.shipper), s(d.loadPort) || s(d.originPort), s(d.dischargePort) || s(d.destPort), s(d.etd), s(d.eta),
  ]);
  return { status: 200, json: { success: true, rows } };
}

module.exports = { arPush, arGet, arBucketsGet, arBucketsSave, arDetail, buildArPayload, arLobKey, normalizeName };
