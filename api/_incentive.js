// ─────────────────────────────────────────────────────────────────
//  api/_incentive.js  —  Incentive page: shipments with money outstanding
//  Not a route (leading underscore): required by api/mongo-batch.js.
//
//  GET action=incentiveOutstanding
//  Reads the Ref No straight from the ar_outstanding collection and returns
//    refs     every Ref No that has a positive outstanding (payment not received)
//    lateRefs Ref No → overdue days, for fully paid invoices paid more than LATE_DAYS
//             past their due date (the sync's _paid rows: last Receipt Date −
//             (Trans. Date + Credit Days))
//  The AR sync stores the sheet's "Reference No." column as refNo; a field literally named "Ref No" also
//  counts. The Incentive page takes those shipments' GP off, along with jobs whose Financial Lock isn't done.
// ─────────────────────────────────────────────────────────────────

const AR_COLLECTION = "ar_outstanding";
const REF_FIELDS = ["refNo", "Ref No"];
const CACHE_TTL_MS = 10 * 60 * 1000;
const LATE_DAYS = 30; // paid more than this many days overdue → GP taken off

// "1,234.00", "(456.00)", -456 → number
function num(v) {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  const s = String(v == null ? "" : v).trim();
  if (!s || s === "-") return 0;
  const neg = /^\(.*\)$/.test(s);
  const n = parseFloat(s.replace(/[(),\s]/g, ""));
  return isNaN(n) ? 0 : (neg ? -n : n);
}

// Same key the page uses for Shipment No
function refKey(v) {
  return String(v == null ? "" : v).trim().toUpperCase();
}

let cache = null; // { key, time, data }

async function incentiveOutstanding(db, force) {
  const meta = await db.collection("_meta").findOne({ _id: "ar_meta" });
  const key = (meta && meta.currentBatch) || "";
  if (!force && cache && cache.key === key && Date.now() - cache.time < CACHE_TTL_MS) return cache.data;

  const col = db.collection(AR_COLLECTION);
  const docs = await col.find(
    { $or: REF_FIELDS.map((f) => ({ [f]: { $exists: true, $nin: ["", null] } })) },
    { projection: Object.assign({ _id: 0, outstanding: 1, Outstanding: 1, "Outstanding (INR)": 1, _paid: 1, paidOverdueDays: 1 }, ...REF_FIELDS.map((f) => ({ [f]: 1 }))) }
  ).toArray();

  const refs = {};
  const lateRefs = {};
  let paidDocs = 0;
  const eachRef = (d, fn) => {
    // One cell can list more than one shipment
    const ref = REF_FIELDS.map((f) => d[f]).filter((v) => v !== undefined && v !== null && v !== "").join("\n");
    String(ref).split(/[\n,;]+/).forEach((part) => { const k = refKey(part); if (k) fn(k); });
  };
  for (const d of docs) {
    if (d._paid) {
      paidDocs++;
      const days = num(d.paidOverdueDays);
      if (days > LATE_DAYS) eachRef(d, (k) => { lateRefs[k] = Math.max(lateRefs[k] || 0, days); });
      continue;
    }
    const raw = d.outstanding !== undefined ? d.outstanding
      : d.Outstanding !== undefined ? d.Outstanding
      : d["Outstanding (INR)"];
    if (!(num(raw) > 0)) continue;
    eachRef(d, (k) => { refs[k] = true; });
  }

  // Paid-invoice rows in the whole collection (any batch, with or without a Ref No) — shows whether the
  // updated AR sync has run at all
  const paidAll = await col.countDocuments({ _paid: true });
  const total = await col.countDocuments({});

  // Nothing found → report which fields the collection does have, so a wrong field name is easy to spot
  let fields = null;
  if (!docs.length) {
    const one = await col.findOne({});
    fields = one ? Object.keys(one).filter((k) => k.charAt(0) !== "_") : [];
  }

  const data = {
    success: true,
    asOn: meta ? meta.asOn || null : null,
    docsWithRef: docs.length,
    refs: Object.keys(refs),
    lateDays: LATE_DAYS,
    lateRefs,
    paidDocs, // 0 until the AR sync that sends paid invoices has run
    paidAll,
    total,
    batch: key,
    fields,
  };
  cache = { key, time: Date.now(), data };
  return data;
}

module.exports = { incentiveOutstanding };
