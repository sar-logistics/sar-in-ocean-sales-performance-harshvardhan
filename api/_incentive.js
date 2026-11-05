// ─────────────────────────────────────────────────────────────────
//  api/_incentive.js  —  Incentive page: shipments with money outstanding
//  Not a route (leading underscore): required by api/mongo-batch.js.
//
//  GET action=incentiveOutstanding
//  Reads the Ref No straight from the ar_outstanding collection and returns
//  every Ref No that has a positive outstanding. The AR sync stores the sheet's
//  "Reference No." column as refNo; a field literally named "Ref No" also counts. The Incentive page leaves
//  those shipments' GP out ("GP (Achieved - Outstanding)").
// ─────────────────────────────────────────────────────────────────

const AR_COLLECTION = "ar_outstanding";
const REF_FIELDS = ["refNo", "Ref No"];
const CACHE_TTL_MS = 10 * 60 * 1000;

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
    { projection: Object.assign({ _id: 0, outstanding: 1, Outstanding: 1, "Outstanding (INR)": 1 }, ...REF_FIELDS.map((f) => ({ [f]: 1 }))) }
  ).toArray();

  const refs = {};
  for (const d of docs) {
    const raw = d.outstanding !== undefined ? d.outstanding
      : d.Outstanding !== undefined ? d.Outstanding
      : d["Outstanding (INR)"];
    if (!(num(raw) > 0)) continue;
    // One cell can list more than one shipment
    const ref = REF_FIELDS.map((f) => d[f]).filter((v) => v !== undefined && v !== null && v !== "").join("\n");
    String(ref).split(/[\n,;]+/).forEach((part) => {
      const k = refKey(part);
      if (k) refs[k] = true;
    });
  }

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
    fields,
  };
  cache = { key, time: Date.now(), data };
  return data;
}

module.exports = { incentiveOutstanding };
