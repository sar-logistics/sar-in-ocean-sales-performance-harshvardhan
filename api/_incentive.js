// ─────────────────────────────────────────────────────────────────
//  api/_incentive.js  —  Incentive page: shipments with money outstanding
//  Not a route (leading underscore): required by api/mongo-batch.js.
//
//  GET action=incentiveOutstanding
//  Reads the Ref No straight from the ar_outstanding collection and returns
//    refs     every Ref No that has a positive outstanding (payment not received)
//    lateRefs Ref No → overdue days, for fully paid invoices paid more than LATE_DAYS
//             past their due date (the sync's _paid rows: last Receipt Date −
//             (Trans. Date, or ATA/ETA for OVR Receivable, + Credit Days) — the AR page's rule)
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
    pushedAt: meta ? meta.pushedAt || null : null, // when the AR sync last finished a push
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

// ─────────────────────────────────────────────────────────────────
//  Payout runs and the shipment ledger
//
//  incentive_runs    one document per run (a quarter): the rules used, every rep's numbers, checks, totals
//  incentive_ledger  one entry per shipment (Shipment No + Core/Cross + rep) per run, never edited:
//                      paid     incentive given in this run (released = held earlier, clean now)
//                      held     not paid yet (FL not done / O/S amount), looked at again by the next run
//                      removed  never paid (rep below 75% that quarter, or paid more than 30 days overdue)
//                      already  skipped: an earlier run already paid or removed it (prevRun says which)
//  Rules (user, 17-Nov-2026): below 75% → removed for good; a held shipment is paid once clean if the rep was
//  eligible in its own quarter (it is only held when they were); a payout is final, later GP changes are ignored.
//
//  Trial runs never count as paid for a real (final) run. They do see earlier trial quarters, so a chain of
//  trials (Q1, then Q2…) shows releases and "already paid" exactly as real runs would. Running a trial again
//  for the same quarter replaces it.
//  The database itself refuses a second closed (paid / removed) entry for the same shipment in final runs, and a
//  second final run for the same quarter. Final runs stay switched off until FINAL_ENABLED is set.
// ─────────────────────────────────────────────────────────────────
const RUNS = "incentive_runs";
const LEDGER = "incentive_ledger";
const FINAL_ENABLED = false; // Incentive % and the paid-late data aren't in yet
let indexesReady = false;

async function ensureIndexes(db) {
  if (indexesReady) return;
  const L = db.collection(LEDGER), R = db.collection(RUNS);
  await L.createIndex({ key: 1 }, { unique: true, partialFilterExpression: { closed: true }, name: "one_closed_final_entry_per_shipment" });
  await L.createIndex({ runId: 1 });
  await L.createIndex({ s: 1 });
  await L.createIndex({ base: 1, mode: 1 });
  await R.createIndex({ quarter: 1 }, { unique: true, partialFilterExpression: { final: true }, name: "one_final_run_per_quarter" });
  indexesReady = true;
}

const PARTS = ["core", "cross"];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const qOk = (q) => /^FY\d{2}-Q[1-4]$/.test(String(q || ""));

// Entries of earlier runs a new run has to respect: finals only for a final run; finals + trials of earlier
// quarters for a trial run
async function priorEntries(db, quarter, mode) {
  const runs = await db.collection(RUNS)
    .find(mode === "final" ? { final: true, quarter: { $lt: quarter } } : { quarter: { $lt: quarter } }, { projection: { _id: 1, quarter: 1, label: 1, final: 1 } })
    .sort({ quarter: 1 }).toArray();
  if (!runs.length) return { runs, byKey: {}, closedShip: {} };
  const runInfo = {};
  runs.forEach((r) => { runInfo[r._id] = r; });
  const entries = await db.collection(LEDGER)
    .find({ runId: { $in: runs.map((r) => r._id) }, status: { $ne: "already" } },
      { projection: { _id: 0, runId: 1, key: 1, base: 1, s: 1, rep: 1, zone: 1, part: 1, month: 1, gp: 1, status: 1, why: 1, customer: 1, fromRun: 1, fromLabel: 1 } })
    .toArray();
  entries.sort((a, b) => (runInfo[a.runId].quarter < runInfo[b.runId].quarter ? -1 : 1));
  const byKey = {};       // key → its latest entry (held / paid / removed)
  const closedShip = {};  // Shipment No + part → the run that paid or removed it (any rep)
  for (const e of entries) {
    e.runLabel = runInfo[e.runId].label;
    byKey[e.key] = e;
    if ((e.status === "paid" || e.status === "removed") && e.base) closedShip[e.base] = { runId: e.runId, label: e.runLabel, status: e.status };
  }
  return { runs, byKey, closedShip };
}

// GET action=incentiveHeld&quarter=FY27-Q3&mode=trial → shipments still held from earlier runs (the page sends back
// their current state with the new run)
async function incentiveHeld(db, q) {
  const quarter = String(q.quarter || ""), mode = q.mode === "final" ? "final" : "trial";
  if (!qOk(quarter)) return { status: 400, json: { success: false, error: "quarter like FY27-Q2 required" } };
  const { byKey } = await priorEntries(db, quarter, mode);
  const held = Object.values(byKey).filter((e) => e.status === "held").map((e) => ({ key: e.key, s: e.s, part: e.part, rep: e.rep }));
  return { status: 200, json: { success: true, held } };
}

// POST action=incentiveRunSave
//  { quarter:"FY27-Q2", label:"Q2 FY27", months:[…], mode:"trial", asOn, arPaidDocs, by:{name,email}, rules:{…},
//    reps:[{ rep, zone, noTarget, core:{gp,tgt}, cross:{gp,tgt} }],
//    ships:[{ s, rep, zone, part, month, gp, customer, why }],   // this quarter, one per Shipment No + part + rep
//    recheck:{ key: { why } | { missing:true } },              // shipments held earlier, as they stand now
//    checks:{ spGp, unassignedGp, unassignedRows } }
async function incentiveRunSave(db, body) {
  const quarter = String(body.quarter || ""), mode = body.mode === "final" ? "final" : "trial";
  if (!qOk(quarter)) return { status: 400, json: { success: false, error: "quarter like FY27-Q2 required" } };
  if (mode === "final" && (!FINAL_ENABLED || process.env.VERCEL_ENV !== "production"))
    return { status: 403, json: { success: false, error: "Final payout runs are switched off until the Incentive % and the paid-late data are in. Trial runs only." } };
  const reps = Array.isArray(body.reps) ? body.reps : [], ships = Array.isArray(body.ships) ? body.ships : [];
  if (!reps.length) return { status: 400, json: { success: false, error: "No reps in the run" } };
  await ensureIndexes(db);
  const rules = Object.assign({ minAchv: 75, feePct: 0.15, lateDays: LATE_DAYS, ratePct: null, coreLobs: ["SEA EXPORT", "SEA IMPORT"] }, body.rules || {});

  // Rep eligibility per part: GP ÷ GP Target, rounded as the page shows it, at least minAchv
  const repInfo = {};
  for (const r of reps) {
    const x = repInfo[r.rep] = { rep: r.rep, zone: r.zone || "", noTarget: !!r.noTarget };
    for (const p of PARTS) {
      const gp = r2(r[p] && r[p].gp), tgt = r2(r[p] && r[p].tgt);
      const pct = tgt > 0 ? Math.round((gp / tgt) * 100) : null;
      x[p] = { gp, tgt, pct, elig: !x.noTarget && pct !== null && pct >= rules.minAchv,
        paid: 0, released: 0, held: 0, removed: 0, removedBelow: 0, removedLate: 0, already: 0, heldFl: 0, heldOs: 0, shipGp: 0 };
    }
  }

  const prior = await priorEntries(db, quarter, mode);
  const runId = quarter + ":" + mode + ":" + Date.now();
  const label = String(body.label || quarter);
  const now = new Date();
  const out = [];
  const seen = {};
  const add = (e) => { out.push(Object.assign({ runId, quarter, mode, at: now }, e)); };
  const repPart = (rep, part) => (repInfo[rep] || (repInfo[rep] = { rep, zone: "", noTarget: true, core: null, cross: null }))[part]
    || (repInfo[rep][part] = { gp: 0, tgt: 0, pct: null, elig: false, paid: 0, released: 0, held: 0, removed: 0, removedBelow: 0, removedLate: 0, already: 0, heldFl: 0, heldOs: 0, shipGp: 0 });

  // 1. Shipments held by an earlier run: paid now if clean, removed if it turned out paid late, else still held
  const recheck = body.recheck || {};
  for (const key of Object.keys(prior.byKey)) {
    const h = prior.byKey[key];
    if (h.status !== "held") continue;
    seen[key] = true;
    const now2 = recheck[key] || { missing: true };
    const P = repPart(h.rep, h.part);
    const base = { key: h.key, base: h.base, s: h.s, rep: h.rep, zone: h.zone, part: h.part, month: h.month, gp: h.gp, customer: h.customer,
      fromRun: h.fromRun || h.runId, fromLabel: h.fromLabel || h.runLabel };
    if (prior.closedShip[h.base]) { add(Object.assign(base, { status: "already", why: "already", prevRun: prior.closedShip[h.base] })); continue; }
    if (now2.missing) { P.held += h.gp; add(Object.assign(base, { status: "held", why: h.why, note: "Not in the current shipment data" })); continue; }
    if (now2.why === "late") { P.removed += h.gp; P.removedLate += h.gp; add(Object.assign(base, { status: "removed", why: "late", closed: mode === "final" })); continue; }
    if (now2.why === "fl" || now2.why === "unpaid") { P.held += h.gp; if (now2.why === "fl") P.heldFl += h.gp; else P.heldOs += h.gp; add(Object.assign(base, { status: "held", why: now2.why })); continue; }
    P.paid += h.gp; P.released += h.gp;
    add(Object.assign(base, { status: "paid", why: null, released: true, closed: mode === "final" }));
  }

  // 2. This quarter's shipments
  let shipGp = 0;
  for (const x of ships) {
    const part = x.part === "cross" ? "cross" : "core";
    const s = String(x.s || "").trim().toUpperCase();
    const rep = String(x.rep || "");
    const base = s ? s + "|" + part : null;
    const key = s ? base + "|" + rep : "NOREF|" + (x.month || "") + "|" + part + "|" + rep;
    if (seen[key]) continue; // released above (its date moved into this quarter)
    seen[key] = true;
    const gp = r2(x.gp);
    shipGp += gp;
    const P = repPart(rep, part);
    P.shipGp += gp;
    const e = { key, base, s: s || null, rep, zone: x.zone || (repInfo[rep] && repInfo[rep].zone) || "", part, month: x.month || "", gp,
      customer: x.customer || "", fromRun: runId, fromLabel: label };
    if (base && prior.closedShip[base]) { P.already += gp; add(Object.assign(e, { status: "already", why: "already", prevRun: prior.closedShip[base] })); continue; }
    if (!P.elig) { P.removed += gp; P.removedBelow += gp; add(Object.assign(e, { status: "removed", why: "below", closed: mode === "final" })); continue; }
    if (x.why === "late") { P.removed += gp; P.removedLate += gp; add(Object.assign(e, { status: "removed", why: "late", closed: mode === "final" })); continue; }
    if (x.why === "fl" || x.why === "unpaid") { P.held += gp; if (x.why === "fl") P.heldFl += gp; else P.heldOs += gp; add(Object.assign(e, { status: "held", why: x.why })); continue; }
    P.paid += gp;
    add(Object.assign(e, { status: "paid", why: null, closed: mode === "final" }));
  }

  // 3. Per rep: the base paid on = paid GP; fees 15% of it (when positive); incentive = rate × what is left
  const repsOut = Object.values(repInfo).map((x) => {
    for (const p of PARTS) {
      const P = x[p];
      if (!P) continue;
      ["paid", "released", "held", "removed", "removedBelow", "removedLate", "already", "heldFl", "heldOs", "shipGp"].forEach((k) => { P[k] = r2(P[k]); });
      P.fee = r2(Math.max(0, P.paid) * rules.feePct);
      P.final = r2(P.paid - P.fee);
      P.incentive = rules.ratePct == null ? null : r2(P.final * rules.ratePct / 100);
      // Every rupee of the rep's GP this quarter is in exactly one bucket
      P.gap = r2(P.gp - P.shipGp);
    }
    return x;
  });

  // 4. Checks
  const tot = { paid: 0, released: 0, held: 0, removed: 0, already: 0, fee: 0, final: 0, gp: 0 };
  const count = { paid: 0, held: 0, removed: 0, already: 0, released: 0 };
  repsOut.forEach((x) => PARTS.forEach((p) => { const P = x[p]; if (!P) return; ["paid", "released", "held", "removed", "already", "fee", "final", "gp"].forEach((k) => { tot[k] += P[k]; }); }));
  Object.keys(tot).forEach((k) => { tot[k] = r2(tot[k]); });
  out.forEach((e) => { count[e.status]++; if (e.released) count.released++; });
  const c = body.checks || {};
  const repGaps = repsOut.flatMap((x) => PARTS.filter((p) => x[p] && Math.abs(x[p].gap) > 1).map((p) => ({ rep: x.rep, part: p, gap: x[p].gap })));
  const checks = {
    spGp: r2(c.spGp), repGp: tot.gp, shipGp: r2(shipGp),
    unassignedGp: r2(c.unassignedGp), unassignedRows: c.unassignedRows || 0,
    repGaps: repGaps.slice(0, 50), repGapCount: repGaps.length,
    paidDataMissing: !(Number(body.arPaidDocs) > 0),
    rateMissing: rules.ratePct == null,
  };
  checks.gpMatches = Math.abs(checks.spGp - checks.repGp) <= 1 && repGaps.length === 0;
  checks.ok = checks.gpMatches && !checks.paidDataMissing && !checks.rateMissing;
  if (mode === "final" && !checks.ok) return { status: 409, json: { success: false, error: "Checks failed, run not saved", checks } };

  const run = {
    _id: runId, quarter, label, mode, final: mode === "final", months: body.months || [], at: now,
    by: body.by || null, env: process.env.VERCEL_ENV || "local", asOn: body.asOn || null, rules, checks, totals: tot, counts: count,
    reps: repsOut,
  };
  // A trial run for the same quarter replaces the earlier one
  if (mode === "trial") {
    const old = await db.collection(RUNS).find({ quarter, mode: "trial" }, { projection: { _id: 1 } }).toArray();
    if (old.length) {
      const ids = old.map((o) => o._id);
      await db.collection(LEDGER).deleteMany({ runId: { $in: ids } });
      await db.collection(RUNS).deleteMany({ _id: { $in: ids } });
    }
  }
  if (out.length) {
    for (let i = 0; i < out.length; i += 2000) await db.collection(LEDGER).insertMany(out.slice(i, i + 2000), { ordered: true });
  }
  await db.collection(RUNS).insertOne(run);
  return { status: 200, json: { success: true, runId, counts: count, totals: tot, checks } };
}

// GET action=incentiveRuns → every run, without the per-rep detail
async function incentiveRuns(db) {
  const runs = await db.collection(RUNS).find({}, { projection: { reps: 0 } }).sort({ quarter: -1, at: -1 }).toArray();
  return { status: 200, json: { success: true, runs, finalEnabled: FINAL_ENABLED } };
}

// GET action=incentiveRun&id=… → the run with its reps and every shipment entry
async function incentiveRun(db, id) {
  const run = await db.collection(RUNS).findOne({ _id: String(id || "") });
  if (!run) return { status: 404, json: { success: false, error: "Run not found" } };
  const entries = await db.collection(LEDGER).find({ runId: run._id }, { projection: { _id: 0, runId: 0, quarter: 0, mode: 0, at: 0, closed: 0 } }).toArray();
  return { status: 200, json: { success: true, run, entries } };
}

// GET action=incentiveShipment&s=SH… → that shipment's story across every run
async function incentiveShipment(db, s) {
  const key = refKey(s);
  if (!key) return { status: 400, json: { success: false, error: "Shipment No required" } };
  const entries = await db.collection(LEDGER).find({ s: key }, { projection: { _id: 0, closed: 0 } }).sort({ quarter: 1, at: 1 }).toArray();
  const ids = [...new Set(entries.map((e) => e.runId))];
  const runs = ids.length ? await db.collection(RUNS).find({ _id: { $in: ids } }, { projection: { label: 1, mode: 1, at: 1 } }).toArray() : [];
  const info = {};
  runs.forEach((r) => { info[r._id] = r; });
  entries.forEach((e) => { const r = info[e.runId]; e.runLabel = r ? r.label : e.runId; e.runMode = r ? r.mode : ""; });
  return { status: 200, json: { success: true, s: key, entries } };
}

// POST action=incentiveRunDelete { id } → trial runs only
async function incentiveRunDelete(db, body) {
  const id = String((body && body.id) || "");
  const run = await db.collection(RUNS).findOne({ _id: id }, { projection: { mode: 1 } });
  if (!run) return { status: 404, json: { success: false, error: "Run not found" } };
  if (run.mode !== "trial") return { status: 403, json: { success: false, error: "Only trial runs can be deleted" } };
  await db.collection(LEDGER).deleteMany({ runId: id });
  await db.collection(RUNS).deleteOne({ _id: id });
  return { status: 200, json: { success: true } };
}

module.exports = { incentiveOutstanding, incentiveHeld, incentiveRunSave, incentiveRuns, incentiveRun, incentiveShipment, incentiveRunDelete };
