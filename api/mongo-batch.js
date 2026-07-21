// ─────────────────────────────────────────────────────────────────
//  api/mongo-batch.js  —  Vercel Serverless Function
//  No auth secret — called from Google Apps Script only
// ─────────────────────────────────────────────────────────────────

const { MongoClient } = require("mongodb");

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME   = "sar-in-air-sales";  // Option B: same DB as Air, Ocean dashboard filters differently
const USD_TO_INR = 94; // Exchange rate used to convert USD targets → INR (same base as GP values)

const COLLECTIONS = {
  "Sea Export":        "jobs_sea_export",
  "Sea Import":        "jobs_sea_import",
  "Air Export":        "jobs_air_export",
  "Air Import":        "jobs_air_import",
  "ISO Tank - Export": "jobs_isotank_export",
  "ISO Tank - Import": "jobs_isotank_import",
  "General":           "jobs_general",
  "Road":              "jobs_road",
  "Clearance - Export": "jobs_clearance_export",
  "Clearance - Import": "jobs_clearance_import",
};

const MAPPING_COLLECTIONS = new Set([
  "mapping_sales_targets",
  "mapping_zone_targets",
  "ocean_mapping_sales_targets",
  "ocean_mapping_zone_targets",
]);

let cachedClient = null;

async function getDB() {
  if (cachedClient) return cachedClient.db(DB_NAME);
  cachedClient = new MongoClient(MONGO_URI, {
    connectTimeoutMS: 15000,
    serverSelectionTimeoutMS: 15000,
  });
  await cachedClient.connect();
  return cachedClient.db(DB_NAME);
}

async function batchInsertJobs(db, records, clearFirst = true, fy = null) {
  const summary = {};
  const errors  = [];

  for (const [tabName, rows] of Object.entries(records)) {
    const collectionName = COLLECTIONS[tabName];
    if (!collectionName) {
      errors.push(`Unknown tab: "${tabName}" — skipped.`);
      continue;
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      summary[tabName] = 0;
      continue;
    }
    try {
      const col = db.collection(collectionName);
      const stamped = rows.map((row) => ({ ...row, _tab: tabName, _fy: fy || null, _insertedAt: new Date() }));
      // clearFirst only on first chunk — subsequent chunks append
      if (clearFirst) {
        if (fy) await col.deleteMany({ _fy: fy });
        else    await col.deleteMany({});
      }
      const result = await col.insertMany(stamped, { ordered: false });
      summary[tabName] = result.insertedCount;
    } catch (err) {
      errors.push(`${tabName}: ${err.message}`);
      summary[tabName] = 0;
    }
  }
  return { summary, errors };
}

async function batchInsertMapping(db, collectionName, records, fy = null) {
  if (!MAPPING_COLLECTIONS.has(collectionName)) {
    return { error: `Unknown mapping collection: "${collectionName}"` };
  }
  if (!Array.isArray(records) || records.length === 0) return { inserted: 0 };
  const col = db.collection(collectionName);
  // Only wipe THIS fiscal year's previously-pushed mapping rows — FY26 and
  // FY27 mapping data now coexist in the same collection. If no fy tag is
  // given, fall back to wiping the whole collection (legacy behavior).
  if (fy) await col.deleteMany({ _fy: fy });
  else await col.deleteMany({});
  const stamped = records.map((row) => ({ ...row, _fy: fy || null, _insertedAt: new Date() }));
  const result  = await col.insertMany(stamped, { ordered: false });
  return { inserted: result.insertedCount };
}

async function batchUpsertUsers(db, users) {
  if (!Array.isArray(users) || users.length === 0) {
    return { inserted: 0, updated: 0, errors: ["No users provided"] };
  }
  const col     = db.collection("users");
  const results = { inserted: 0, updated: 0, errors: [] };
  for (const u of users) {
    const email = u.email?.toLowerCase().trim();
    if (!email || !u.name) { results.errors.push(`Skipped: ${JSON.stringify(u)}`); continue; }
    try {
      const result = await col.updateOne(
        { email },
        {
          $set: { name: u.name, email, role: u.role || "user", isActive: u.isActive !== undefined ? u.isActive : true, updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date(), lastLogin: null, photoUrl: "" },
        },
        { upsert: true }
      );
      if (result.upsertedCount > 0) results.inserted++;
      else if (result.modifiedCount > 0) results.updated++;
    } catch (err) { results.errors.push(`${email}: ${err.message}`); }
  }
  return results;
}

// ── ACTION: org (read-only org chart) ─────────────────────────────
async function getOrgChart(db) {
  const users = await db.collection("users").find({}).toArray();

  var people = users.map(function(u){
    return {
      email:     u.email || "",
      name:      u.name  || "",
      role:      u.role  || "user",
      reportsTo: (u.reportsTo || "").toLowerCase().trim(),
      zone:      u.zone   || "",
      region:    u.region || "",
      isActive:  u.isActive !== false,
      lastLogin: u.lastLogin || null,
      loginCount: u.loginCount || 0,
    };
  });

  // Roles considered part of the management hierarchy chain (vertical org chart)
  var HIERARCHY_ROLES = new Set(["regional manager", "zonal manager", "manager"]);
  // Roles shown as flat "support" cards on the side, not in the vertical chain
  var SUPPORT_ROLES = new Set(["admin", "hr"]);

  var byEmail = {};
  people.forEach(function(p){ byEmail[p.email.toLowerCase()] = p; });

  function isHierarchyRole(role){
    return HIERARCHY_ROLES.has(String(role||"").toLowerCase().trim());
  }
  function isSupportRole(role){
    return SUPPORT_ROLES.has(String(role||"").toLowerCase().trim());
  }

  var hierarchy = people.filter(function(p){ return isHierarchyRole(p.role); });
  var directReports = people.filter(function(p){ return !isHierarchyRole(p.role) && !isSupportRole(p.role); });
  var support = people.filter(function(p){ return isSupportRole(p.role); });

  // Count direct reports for each hierarchy person (by reportsTo email match)
  hierarchy.forEach(function(h){
    h.reportCount = people.filter(function(p){
      return p.reportsTo && byEmail[p.reportsTo] && byEmail[p.reportsTo].email.toLowerCase() === h.email.toLowerCase();
    }).length;
  });

  return {
    success: true,
    totalUsers: people.length,
    hierarchy: hierarchy,       // vertical chain: Regional/Zonal Managers
    directReports: directReports, // flat row under hierarchy: Sales Reps etc.
    support: support,           // side panel: Admin/HR
    pushedAt: new Date().toISOString(),
  };
}

async function updateUserFields(db, email, fields) {
  if (!email) return { error: "email is required" };
  var allowed = {};
  if (fields.role      !== undefined) allowed.role      = fields.role;
  if (fields.reportsTo !== undefined) allowed.reportsTo = String(fields.reportsTo || "").toLowerCase().trim();
  if (fields.zone      !== undefined) allowed.zone      = String(fields.zone || "").trim();
  if (fields.region    !== undefined) allowed.region    = String(fields.region || "").trim();
  if (fields.isActive  !== undefined) allowed.isActive  = !!fields.isActive;
  if (fields.name      !== undefined) allowed.name      = String(fields.name || "").trim();
  if (Object.keys(allowed).length === 0) return { error: "No valid fields to update" };
  allowed.updatedAt = new Date();
  var result = await db.collection("users").updateOne(
    { email: email.toLowerCase().trim() },
    { $set: allowed }
  );
  if (result.matchedCount === 0) return { error: "User not found" };
  return { updated: true };
}


const JOB_COLLECTIONS = [
  "jobs_sea_export", "jobs_sea_import", "jobs_air_export", "jobs_air_import",
  "jobs_isotank_export", "jobs_isotank_import", "jobs_general", "jobs_road",
  "jobs_clearance_export", "jobs_clearance_import",
];

// ISO Tank rows are identified by which sheet tab they came from (the _tab
// stamp added at insert time), since ISO Tank has its own dedicated tabs —
// this is reliable regardless of what the LOB column says on those rows.
const ISOTANK_COLLECTIONS = new Set(["jobs_isotank_export", "jobs_isotank_import"]);

// Everything else is classified by the row's actual "LOB" column value,
// NOT by which MongoDB collection it landed in. This protects against rows
// being misfiled into the wrong sheet tab/collection (e.g. an ISO Tank row
// sitting inside the Sea Export tab) — the LOB text on the row is the
// source of truth for Export vs Import vs Air vs Sea classification.
function classifyRow(job, collName) {
  if (ISOTANK_COLLECTIONS.has(collName)) {
    const isExport = collName === "jobs_isotank_export";
    return { kind: "ISOTANK", direction: isExport ? "EXPORT" : "IMPORT" };
  }

  const lob = String(job["LOB"] || "").toUpperCase().trim();

  if (lob === "SEA EXPORT")      return { kind: "SEA",       direction: "EXPORT" };
  if (lob === "SEA IMPORT")      return { kind: "SEA",       direction: "IMPORT" };
  if (lob === "AIR EXPORT")      return { kind: "AIR",       direction: "EXPORT" };
  if (lob === "AIR IMPORT")      return { kind: "AIR",       direction: "IMPORT" };
  if (lob === "CLEARANCE EXPORT") return { kind: "CLEARANCE", direction: "EXPORT" };
  if (lob === "CLEARANCE IMPORT") return { kind: "CLEARANCE", direction: "IMPORT" };
  if (lob === "GENERAL")         return { kind: "GENERAL",   direction: null };
  if (lob === "ROAD")            return { kind: "ROAD",       direction: null };

  // Unknown/blank LOB — fall back to the collection it was pushed from,
  // so the row still gets *some* reasonable treatment instead of being dropped.
  if (collName.includes("sea"))       return { kind: "SEA",       direction: collName.includes("import") ? "IMPORT" : "EXPORT" };
  if (collName.includes("air"))       return { kind: "AIR",       direction: collName.includes("import") ? "IMPORT" : "EXPORT" };
  if (collName.includes("clearance")) return { kind: "CLEARANCE", direction: collName.includes("import") ? "IMPORT" : "EXPORT" };
  if (collName.includes("general"))   return { kind: "GENERAL",   direction: null };
  if (collName.includes("road"))      return { kind: "ROAD",       direction: null };
  return { kind: "UNKNOWN", direction: null };
}

// Tons metric is calculated only for AIR rows (Export or Import)
function isAirRow(cls) { return cls.kind === "AIR"; }

// One source of truth for air-tonnage conversion. The blank/default unit in
// the source sheet is kilograms, while the dashboard displays metric tonnes.
function calculateAirTons(job, cls) {
  if (!isAirRow(cls)) return 0;
  const rawWeight = parseFloat(job["Chargeable Weight"] || 0) || 0;
  const unit = String(job["Chargeable Weight Unit"] || "").toLowerCase().trim();
  if (unit === "ton" || unit === "tons" || unit === "mt") return rawWeight;
  if (unit === "lb" || unit === "lbs") return rawWeight * 0.000453592;
  return rawWeight / 1000;
}

// Pick the correct GP field based on lock status
// Air (Import/Export): if "Financial Lock" is empty → Provisional; else Actual
// All others:          if "Operation Lock" is empty → Provisional; else Actual
function pickGP(job, cls) {
  const isAir = cls.kind === "AIR";
  const lockField = isAir ? "Financial Lock" : "Operation Lock";
  const isLocked  = job[lockField] !== undefined && job[lockField] !== null && String(job[lockField]).trim() !== "";
  const actual      = parseFloat(job["Actual Profit (J=C-G)"]     || 0) || 0;
  const provisional = parseFloat(job["Provisional Profit (I=A-E)"] || 0) || 0;
  return { gp: isLocked ? actual : provisional, isProvisional: !isLocked };
}

// TEU and LCL(CBM) metrics are calculated only for SEA and ISOTANK rows
function hasTeuLclRow(cls) { return cls.kind === "SEA" || cls.kind === "ISOTANK"; }

// Decides which physical metric a row's Cargo Type maps to, independent of
// LOB kind. This is the source of truth for TEU vs LCL within Sea/ISO Tank
// rows — a Sea Export row can be FCL (→ Container TEU) or LCL (→ Volume)
// depending purely on what Cargo Type says, not on its LOB classification.
function cargoMetricFor(job) {
  const cargoType = String(job["Cargo Type"] || "").toUpperCase().trim();
  if (cargoType === "FCL" || cargoType === "LIQUID (CONT)") return "TEU";
  if (cargoType === "LCL") return "LCL";
  return null; // unrecognized Cargo Type — contributes to neither TEU nor LCL
}

// Date column: Export-direction rows use "ETD Loading Port", Import-direction
// rows use "ETA Discharge". GENERAL/ROAD (no direction) use "Job Date" only.
// All fall back to "Job Date" if the primary column is blank.
function getDateColumnFor(cls) {
  if (cls.direction === "EXPORT") return "ETD Loading Port";
  if (cls.direction === "IMPORT") return "ETA Discharge";
  return "Job Date";
}

// Google Sheets exports dates such as 04/05/2026 in day/month/year format.
// `new Date("04/05/2026")` treats that as April 5 in JavaScript, incorrectly
// putting 4 May shipments into April. Parse date-only values explicitly and
// use this for every report and drill-down month bucket.
function parseSheetDate(value) {
  if (value instanceof Date) {
    // Convert UTC date to IST (UTC+5:30) for month bucketing
    const ist = new Date(value.getTime() + (5.5 * 60 * 60 * 1000));
    return ist;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const utc = new Date(excelEpoch.getTime() + Math.round(value * 86400000));
    return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
  }
  const text = String(value || "").trim();
  // ISO string with time component — convert to IST
  if (text.includes("T") && text.includes("Z")) {
    const utcMs = new Date(text).getTime();
    if (!isNaN(utcMs)) {
      return new Date(utcMs + (5.5 * 60 * 60 * 1000));
    }
  }
  let match = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})(?:\s|$)/);
  if (match) {
    const day = Number(match[1]), month = Number(match[2]) - 1;
    const year = Number(match[3].length === 2 ? "20" + match[3] : match[3]);
    const parsed = new Date(year, month, day);
    return parsed.getFullYear() === year && parsed.getMonth() === month && parsed.getDate() === day ? parsed : null;
  }
  match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|T)/);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// Indian Fiscal Years — FY26 runs Apr 2025 → Mar 2026, FY27 runs Apr 2026 → Mar 2027.
// Both are listed here since FY26 and FY27 job data now coexist in the same
// MongoDB collections (appended, not replaced) and need to be recognized
// together for month-bucketing across the combined dataset.
const FY_MONTHS = [
  "Apr-25","May-25","Jun-25","Jul-25","Aug-25","Sep-25",
  "Oct-25","Nov-25","Dec-25","Jan-26","Feb-26","Mar-26",
  "Apr-26","May-26","Jun-26","Jul-26","Aug-26","Sep-26",
  "Oct-26","Nov-26","Dec-26","Jan-27","Feb-27","Mar-27"
];
const MONTH_NAMES  = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function zoneHue(zone) {
  let h = 0;
  for (let i = 0; i < zone.length; i++) h = (h * 31 + zone.charCodeAt(i)) & 0xffff;
  return h % 360;
}

// Normalizes a sales person name for matching: strips "| CODE" suffixes,
// extra whitespace, and lowercases. "Pankaj Kumar | INZ03" → "pankaj kumar"
function normalizeName(name) {
  return String(name || "")
    .split("|")[0]
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// In-memory cache — survives across warm Lambda invocations (same container)

// ── RLS: resolve which reps a user is allowed to see ─────────────────────────
// Ocean hierarchy: Sales Rep → Zonal Manager → Regional Manager (N/W/E/S) → Admin/HR
// Regional Manager sees all reps whose zone maps to their region.
// zone→region mapping comes from mapping_zone_targets "Region" column.
async function _getRLSReps(db, currentUser) {
  const role   = String(currentUser.role   || "").toLowerCase().trim();
  const zone   = String(currentUser.zone   || "").trim();
  const region = String(currentUser.region || "").trim();
  const email  = String(currentUser.email  || "").toLowerCase().trim();

  if (role === "admin" || role === "hr") return null; // null = no filter

  const mappingRows = await _getOceanMappingRows(db, { "Sales Rep Name":1, "Display Name":1, "Zone":1, "Email ID":1 });

  const zoneTargetRows = await db.collection("mapping_zone_targets").find(
    {}, { projection: { "Zone":1, "Region":1 } }
  ).toArray();

  const zoneRegionMap = {};
  for (const r of zoneTargetRows) {
    const z = String(r["Zone"]||"").trim(), reg = String(r["Region"]||"").trim();
    if (z && reg) zoneRegionMap[z] = reg;
  }

  if (role === "regional manager") {
    if (!region) return null; // no region set → see everything
    const allowedZones = new Set(
      Object.entries(zoneRegionMap)
        .filter(([,reg]) => reg.toLowerCase() === region.toLowerCase())
        .map(([z]) => z)
    );
    if (allowedZones.size === 0) return null; // no mapping yet → fallback
    const allowedReps = new Set();
    for (const row of mappingRows) {
      if (allowedZones.has(String(row["Zone"]||"").trim())) {
        const norm = normalizeName(row["Sales Rep Name"]);
        const dn   = normalizeName(row["Display Name"] || row["Sales Rep Name"]);
        if (norm) allowedReps.add(norm);
        if (dn)   allowedReps.add(dn);
      }
    }
    return allowedReps;
  }

  if (role === "zonal manager") {
    if (!zone) return null;
    const allowedReps = new Set();
    for (const row of mappingRows) {
      if (String(row["Zone"]||"").trim() === zone) {
        const norm = normalizeName(row["Sales Rep Name"]);
        const dn   = normalizeName(row["Display Name"] || row["Sales Rep Name"]);
        if (norm) allowedReps.add(norm);
        if (dn)   allowedReps.add(dn);
      }
    }
    return allowedReps;
  }

  // Sales Rep — self only
  const selfNorm = normalizeName(currentUser.name || "");
  const selfSet = new Set();
  if (selfNorm) selfSet.add(selfNorm);
  for (const row of mappingRows) {
    const repEmail = String(row["Email ID"]||"").toLowerCase().trim();
    if (repEmail === email) {
      selfSet.add(normalizeName(row["Sales Rep Name"]));
      selfSet.add(normalizeName(row["Display Name"] || row["Sales Rep Name"]));
    }
  }
  return selfSet;
}

const DEPLOY_TS = "2026-07-21T-ocean-v7-usd-rate"; // bump to force cache rebuild on redeploy
let salesCache = null;
let salesCacheTime = 0;
let salesCacheDeployTs = null;
const SALES_CACHE_TTL_MS = 120 * 60 * 1000; // 2 hours — data pushed from sheets periodically

// ── DRILL-DOWN: real job rows behind a clicked table cell ──────────
// entity: "Grand Total" | zone name | rep display name
// metric: "Shipments" | "GP" | "Tons (Air)" | "TEUs (Ocean)" | "LCL (Ocean in CBM)"
// month: e.g. "Apr-25", or "FY Total" for the whole year
// ── Drill row cache (server-side, lives in salesCache) ───────────────────────
// All pre-classified job rows are computed ONCE during computeSalesAggregate
// and stored in salesCache.drillRows. The drill endpoint then just filters
// this in-memory array — zero MongoDB queries. Since salesCache lives for
// 30 minutes and is shared across all requests to the same container, and
// since the ping endpoint pre-warms salesCache proactively, drill queries
// after the first sales load are served in <50ms.
let drillRowsCache = null; // { rows: [...], mappingData: {...}, cachedAt }
let drillRowsCacheTime = 0;

// Module-level — accessible by both getDrillRows and computeSalesAggregate
function isoWeekInfo(date) {
  var d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  var dayNum = (d.getUTCDay() + 6) % 7;
  var thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() - dayNum + 3);
  var isoYear = thursday.getUTCFullYear();
  var firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  var fThDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fThDayNum + 3);
  var weekNum = 1 + Math.round((thursday - firstThursday) / (7 * 86400000));
  var monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - dayNum);
  var sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  var key = isoYear + '-W' + String(weekNum).padStart(2, '0');
  return { key, weekNum, isoYear, monday, sunday };
}

async function getDrillRows(db, entity, metric, month, lobsParam) {
  const activeLobs = lobsParam ? lobsParam.split(',').map(s=>s.trim()).filter(Boolean) : [];
  const LOB_CL = {
    'AIR EXPORT':     cl => cl.includes('air')     && cl.includes('export'),
    'AIR IMPORT':     cl => cl.includes('air')     && cl.includes('import'),
    'SEA EXPORT':     cl => cl.includes('sea')     && cl.includes('export'),
    'SEA IMPORT':     cl => cl.includes('sea')     && cl.includes('import'),
    'ISOTANK EXPORT': cl => cl.includes('isotank') && cl.includes('export'),
    'ISOTANK IMPORT': cl => cl.includes('isotank') && cl.includes('import'),
  };
  const CROSS_SALES_ZONE = "Cross Sales";

  // ── Use drillRowsCache (pre-classified rows from computeSalesAggregate) ──
  // If salesCache has already loaded the full dataset, drillRowsCache is
  // already populated. No MongoDB queries needed — just filter in memory.
  const now = Date.now();
  const cacheStale = (now - drillRowsCacheTime) > SALES_CACHE_TTL_MS
    || drillRowsCache?.deployTs !== DEPLOY_TS;

  if (!drillRowsCache || cacheStale) {
    // Build drill rows cache from scratch (same DB pass as aggregate)
    const t0 = Date.now();
    // Ocean: use ocean_mapping_sales_targets, fallback to mapping_sales_targets
    let mappingRows = await db.collection("ocean_mapping_sales_targets").find({}).toArray();
    if (!mappingRows || mappingRows.length === 0) {
      mappingRows = await db.collection("mapping_sales_targets").find({}).toArray();
    }
    const repLookupByFY = { FY26: {}, FY27: {} };
    const repsByZoneByFY = { FY26: {}, FY27: {} };
    const normByDisplayByFY = { FY26: {}, FY27: {} };

    for (const row of mappingRows) {
      const rawName = row["Sales Rep Name"];
      const norm = normalizeName(rawName);
      if (!norm) continue;
      const fy = (row._fy === "FY27") ? "FY27" : "FY26";
      const zone = String(row["Zone"] || "Unassigned").trim();
      const displayName = String(row["Display Name"] || rawName || "").trim();
      repLookupByFY[fy][norm] = { displayName, zone };
      if (!repsByZoneByFY[fy][zone]) repsByZoneByFY[fy][zone] = [];
      if (!repsByZoneByFY[fy][zone].includes(norm)) repsByZoneByFY[fy][zone].push(norm);
      normByDisplayByFY[fy][displayName] = norm;
    }

    // Always load ALL FY rows — no date pre-filter.
    // drillRowsCache is reused across all drill requests, so it must be complete.
    // Date/entity filtering happens in-memory below.
    const allResults = await Promise.all(
      JOB_COLLECTIONS.map(c => db.collection(c).find({}).toArray().then(r => ({ collName: c, rows: r })))
    );

    const allRows = [];
    for (const { collName, rows } of allResults) {
      for (const job of rows) {
        const cls = classifyRow(job, collName);
        const dateCol = getDateColumnFor(cls);
        // Use ETD/ETA only — no Job Date fallback. Jobs with blank ETD/ETA are excluded.
        const primaryDateStr = job[dateCol];
        if (!primaryDateStr) continue;
        const d = parseSheetDate(primaryDateStr);
        if (!d) continue;
        const monthLabel = MONTH_NAMES[d.getMonth()] + "-" + String(d.getFullYear()).slice(2);
        if (!FY_MONTHS.includes(monthLabel)) continue;
        const salesPerson = normalizeName(job["Sales Person"]) || "no rep assigned";

        // Resolve zone from mapping — used client-side for zone drill matching
        const _fy = ["Apr-25","May-25","Jun-25","Jul-25","Aug-25","Sep-25","Oct-25","Nov-25","Dec-25","Jan-26","Feb-26","Mar-26"].includes(monthLabel) ? "FY26" : "FY27";
        const _meta = repLookupByFY[_fy]?.[salesPerson] || repLookupByFY["FY26"]?.[salesPerson] || repLookupByFY["FY27"]?.[salesPerson];
        const _zone = _meta ? _meta.zone : null; // null = unmapped/cross sales
        const _dn   = _meta ? _meta.displayName : null; // display name for rep matching

        const { gp: rowGP, isProvisional } = pickGP(job, cls);
        const billedRevenue = parseFloat(job["Billed Revenue (C)"] || 0) || 0;
        const provRevenue   = parseFloat(job["Provisional Revenue (A)"] || 0) || 0;
        const provCost      = parseFloat(job["Provisional Cost (E)"] || 0) || 0;
        const postedCostRaw = job["Posted Cost (G)"];
        const postedCost    = (postedCostRaw != null && String(postedCostRaw).trim() !== "")
          ? (parseFloat(postedCostRaw) || 0)
          : (billedRevenue - (parseFloat(job["Actual Profit (J=C-G)"] || 0) || 0));
        const chargeableWeight = parseFloat(job["Chargeable Weight"] || 0) || 0;
        const chargeableWeightUnit = String(job["Chargeable Weight Unit"] || "").trim();
        const calculatedTons = calculateAirTons(job, cls);

        // Compute tradelane group (_tg) from port field — mirrors SRR tradelane logic
        // Air Export: Discharge Port; Air Import: Loading Port; Sea Export: Discharge Country; Sea Import: Loading Port; ISO Tank: Consignee/Shipper Country
        let _tg = "";
        if (cls.kind === "AIR") {
          const _portField = cls.direction === "EXPORT" ? "Discharge Port" : "Loading Port";
          const _portVal = String(job[_portField] || "").trim();
          _tg = portToInfo(_portVal).tradelane;
          // Fallback: try city name lookup when ISO2 code not found
          if (!_tg && _portVal) _tg = cityToTradelane(_portVal);
        } else if (cls.kind === "SEA") {
          if (cls.direction === "EXPORT") {
            _tg = countryNameToTradelane(job["Discharge Country"] || "") || (job["Discharge Country"] || "");
          } else {
            const _portVal = String(job["Loading Port"] || "").trim();
            _tg = portToInfo(_portVal).tradelane;
            if (!_tg && _portVal) _tg = cityToTradelane(_portVal);
          }
        } else if (cls.kind === "ISOTANK") {
          const _raw = cls.direction === "EXPORT"
            ? (String(job["Consignee Country"] || job["Destination Country"] || "").trim())
            : (String(job["Shipper Country"]   || job["Origin Port Country"] || "").trim());
          _tg = countryNameToTradelane(_raw) || _raw;
        }

        allRows.push({
          _sp: salesPerson,  // normalized
          _ml: monthLabel,
          _d:  d,
          _wk: isoWeekInfo(d).key, // ISO week key — same as weekData bucketing
          _cl: collName,
          _cls: cls,
          shipmentNo: job["Shipment No"]    || "—",
          jobDate:    job["Job Date"]       || "",
          lob: cls.kind + (cls.direction ? " " + cls.direction : ""),
          masterNo: job["Master No."]       || "",
          houseNo:  job["House No."]        || "",
          consolNo: job["Consol No."]       || "",
          cargoType: job["Cargo Type"]      || "",
          carrier:   job["Carrier"] || job["Carrier Name"] || "",
          provRevenue, billedRevenue,
          unbilledRevenue: parseFloat(job["Unbilled Revenue (D=A-C)"] ?? provRevenue - billedRevenue) || 0,
          provCost, postedCost,
          unpostedCost: parseFloat(job["Unposted Cost (H = E-G)"] ?? provCost - postedCost) || 0,
          provisionalProfit: parseFloat(job["Provisional Profit (I=A-E)"] || 0) || 0,
          actualProfit:      parseFloat(job["Actual Profit (J=C-G)"]      || 0) || 0,
          customer:     job["Customer"]            || "",
          ataDischarge: job["ATA Discharge"]       || "",
          atdLoading:   job["ATD Loading Port"]    || "",
          dischargePort: job["Discharge Port"]     || "",
          loadingPort:   job["Loading Port"]       || "",
          location:     job["Location"]            || "",
          consignee:    job["Consignee"]           || "",
          consolType:   job["Consol Type"]         || "",
          teu:  parseFloat(job["Container TEU"]    || 0) || 0,
          destAgent:    job["Destination Agent"]   || "",
          etaDischarge: job["ETA Discharge"]       || "",
          etdLoading:   job["ETD Loading Port"]    || "",
          jobOwner:     job["Job Owner"]           || "",
          jobRevRecogDate: job["Job Rev Recognition Date"] || "",
          originAgent:  job["Origin Agent"]        || "",
          salesPerson:  job["Sales Person"]        || "",
          shipper:      job["Shipper"]             || "",
          volume:  parseFloat(job["Volume"]        || 0) || 0,
          volumeUnit:   job["Volume Unit"]         || "",
          operationLock: job["Operation Lock"]     || "",
          financialLock: job["Financial Lock"]     || "",
          g: rowGP, r: billedRevenue, x: postedCost,
          t: parseFloat(job["Container TEU"] || 0) || 0,
          chargeableWeight,
          chargeableWeightUnit,
          tons: calculatedTons,
          // Retained for backwards compatibility with older cached payloads.
          vol: chargeableWeight,
          prov: isProvisional ? 1 : 0,
          customer: String(job["Customer"] || "").trim(),
          _zone, // zone from mapping — null if unmapped
          _dn,   // display name from mapping — null if unmapped
          _tg,   // tradelane group (US, LATAM, Asia, Europe etc) — for per-country count accuracy
        });
      }
    }

    drillRowsCache = { allRows, repLookupByFY, repsByZoneByFY, normByDisplayByFY, deployTs: DEPLOY_TS };
    drillRowsCacheTime = now;
    console.log(`[drill] Built row cache: ${allRows.length} rows in ${Date.now()-t0}ms`);
  }

  const { allRows, repLookupByFY, repsByZoneByFY, normByDisplayByFY } = drillRowsCache;

  // ── Resolve entity ────────────────────────────────────────────────────────
  const isCrossSalesZone   = entity === CROSS_SALES_ZONE;
  const isGrandTotal       = entity === "Grand Total";
  const isKnownZone        = Object.values(repsByZoneByFY).some(d => d[entity]);
  const isKnownRep         = Object.values(normByDisplayByFY).some(d => d[entity]);
  const isCrossSalesBranch = !isCrossSalesZone && !isGrandTotal && !isKnownZone && !isKnownRep;
  const useCrossSalesPath  = isCrossSalesZone || isCrossSalesBranch;

  // ── Resolve date window ───────────────────────────────────────────────────
  const isFYTotal   = month === "FY Total";
  const isYearGroup = month?.startsWith("YEAR:");
  const yearSuffix  = isYearGroup ? month.split(":")[1] : null;
  const isRange     = month?.startsWith("RANGE:");
  const rangeParts  = isRange ? (() => { const b=month.split(":"); return {start:b[1],end:b[2]}; })() : null;
  const isWeek      = month?.startsWith("WEEK:");
  const isDateRange = month?.startsWith("DATERANGE:");
  const isAirMetric    = metric === "Tons (Air)";
  const isTeuLclMetric = metric === "TEUs (Ocean)" || metric === "LCL (Ocean in CBM)";

  let weekRange = null, drParts = null;
  if (isWeek) {
    const [iyS, wnS] = month.slice(5).split("-W");
    const iy=parseInt(iyS,10), wn=parseInt(wnS,10);
    const j4=new Date(Date.UTC(iy,0,4)); const j4d=(j4.getUTCDay()+6)%7;
    const w1m=new Date(j4); w1m.setUTCDate(j4.getUTCDate()-j4d);
    const mon=new Date(w1m); mon.setUTCDate(w1m.getUTCDate()+(wn-1)*7);
    const sun=new Date(mon); sun.setUTCDate(mon.getUTCDate()+6); sun.setUTCHours(23,59,59,999);
    weekRange={start:mon, end:sun};
  }
  if (isDateRange) {
    const b=month.split(":");
    drParts={start:new Date(b[1]+"T00:00:00Z"), end:new Date(b[2]+"T23:59:59Z")};
  }

  // ── Filter rows ───────────────────────────────────────────────────────────
  const matchedRows = [];
  for (const row of allRows) {
    // No metric-based row exclusion — LOB filter handles row selection, metric only affects value
    // LOB filter — match by row.lob
    if (activeLobs.length > 0 && !isWeek && !isDateRange) {
      if (!activeLobs.includes(row.lob)) continue;
    }

    const d=row._d, ml=row._ml;
    if (!isFYTotal && !isYearGroup && !isRange && !isWeek && !isDateRange && ml !== month) continue;
    if (isYearGroup && yearSuffix && !ml.endsWith('-'+yearSuffix)) continue;
    if (isRange && rangeParts) {
      const fi=FY_MONTHS.indexOf(rangeParts.start), ti=FY_MONTHS.indexOf(rangeParts.end), mi=FY_MONTHS.indexOf(ml);
      if (fi<0||ti<0||mi<fi||mi>ti) continue;
    }
    if (isWeek && row._wk !== month.slice(5)) continue;
    if (isDateRange && drParts  && (d<drParts.start   || d>drParts.end))  continue;

    const sp  = row._sp;
    const fy  = fyForMonthLabel(ml);
    const mapped = repLookupByFY[fy]?.[sp] || repLookupByFY.FY26?.[sp] || repLookupByFY.FY27?.[sp];

    if (isGrandTotal) {
      // All rows pass — Grand Total shows everything (mapped + cross sales + branches)
    } else if (useCrossSalesPath) {
      if (mapped) continue;
      if (isCrossSalesBranch && row.location !== entity) continue;
    } else if (isKnownZone) {
      if (!mapped || mapped.zone !== entity) continue;
    } else {
      const norm = normByDisplayByFY[fy]?.[entity] || normByDisplayByFY.FY26?.[entity] || normByDisplayByFY.FY27?.[entity];
      if (!norm || sp !== norm) continue;
    }

    let metricVal = metric === "Shipments" ? 1 : isAirMetric ? (row.tons||0) : (row.t||0);
    matchedRows.push({ ...row, m: metricVal });
  }

  matchedRows.sort((a,b) => b._d - a._d);
  const totalGP      = matchedRows.reduce((s,r)=>s+(r.g||0),0);
  const totalRevenue = matchedRows.reduce((s,r)=>s+(r.r||0),0);
  const totalMetric  = matchedRows.reduce((s,r)=>s+(r.m||0),0);

  return {
    success: true, entity, metric, month,
    count: matchedRows.length,
    totalMetric, totalGP,
    totalRevenue, totalCost: totalRevenue - totalGP,
    rows: matchedRows,
  };
}


async function getSalesAggregate(db, force) {
  if (!force && salesCache && salesCacheDeployTs === DEPLOY_TS && (Date.now() - salesCacheTime) < SALES_CACHE_TTL_MS) {
    return { ...salesCache, cached: true };
  }


  const result = await computeSalesAggregate(db);
  result._deployTs = DEPLOY_TS;
  salesCache = result;
  salesCacheTime = Date.now();
  salesCacheDeployTs = DEPLOY_TS;
  return result;
}

// Given a month label like "Apr-26", returns which fiscal year it belongs
// to: "FY26" covers Apr-25→Mar-26, "FY27" covers Apr-26→Mar-27.
function fyForMonthLabel(monthLabel) {
  const fy26Months = new Set(["Apr-25","May-25","Jun-25","Jul-25","Aug-25","Sep-25","Oct-25","Nov-25","Dec-25","Jan-26","Feb-26","Mar-26"]);
  return fy26Months.has(monthLabel) ? "FY26" : "FY27";
}

async function computeSalesAggregate(db) {
  // 1. Load sales rep mapping — built as ONE lookup PER FISCAL YEAR, since
  // FY26 and FY27 mapping rows now coexist in the same collection and a
  // rep's zone/target can legitimately differ between the two years.
  const mappingRows = await _getOceanMappingRows(db);
  // Sort oldest→newest so newest rows overwrite old ones for the same rep+FY
  mappingRows.sort((a,b) => new Date(a._insertedAt||0) - new Date(b._insertedAt||0));
  const repLookupByFY = { FY26: {}, FY27: {} };
  for (const row of mappingRows) {
    const key = normalizeName(row["Sales Rep Name"]);
    const displayKey = normalizeName(row["Display Name"] || "");
    if (!key) continue;
    const fy = (row._fy === "FY27") ? "FY27" : "FY26";
    if (!repLookupByFY[fy]) repLookupByFY[fy] = {};
    // Ocean: store raw USD targets — dashboard converts to INR using live state.rate
    const tgtINR = parseFloat(row["Monthly Target (INR)"] || 0) || 0;
    const tgtUSD = parseFloat(row["Monhtly Target (USD)"] || row["Monthly Target (USD)"] || 0) || 0;
    // Store in USD (multiply by 1 — client applies state.rate at render time)
    // If INR is set directly use it, otherwise store USD value tagged with _usd flag
    const monthlyTarget = tgtINR > 0 ? tgtINR : tgtUSD * USD_TO_INR; // fallback INR for server-side calcs
    const monthlyTargetUSD = tgtUSD; // raw USD stored separately
    const weeklyTgtUSD  = parseFloat(row["Weekly Target (USD)"]  || 0) || 0;
    const weeklyTarget  = weeklyTgtUSD * USD_TO_INR;
    const weeklyTargetUSD = weeklyTgtUSD;
    const totalTgtUSD   = parseFloat(row["Total Target (USD)"]   || 0) || 0;
    const yearlyTarget  = totalTgtUSD * USD_TO_INR;
    const yearlyTargetUSD = totalTgtUSD;
    const dailyTarget   = yearlyTarget > 0 ? Math.round(yearlyTarget / 365) : 0;
    const dailyTargetUSD = yearlyTargetUSD > 0 ? Math.round(yearlyTargetUSD / 365 * 100) / 100 : 0;
    const existing = repLookupByFY[fy][key];
    // Overwrite unless existing has a target and new one doesn't
    if (existing && existing.monthlyTarget > 0 && monthlyTarget === 0) continue;
    const entry = {
      displayName:   String(row["Display Name"] || row["Sales Rep Name"] || "").trim(),
      zone:          String(row["Zone"] || "Unassigned").trim(),
      lob:           String(row["LOB"] || "").trim(),
      monthlyTarget,
      weeklyTarget,
      yearlyTarget,
      dailyTarget,
      joinDate:      row["Date of Joining"] ? new Date(row["Date of Joining"]) : null,
      exitDate:      row["Date Of Exit"]    ? new Date(row["Date Of Exit"])    : null,
      email:         String(row["Email ID"] || "").toLowerCase().trim(),
    };
    repLookupByFY[fy][key] = entry;
    // Also index by Display Name if different — handles jobs where Sales Person = display name
    if (displayKey && displayKey !== key) {
      repLookupByFY[fy][displayKey] = entry;
    }
  }

  // 2. Load zone targets — sort oldest→newest so newest wins
  // Ocean: use ocean_mapping_zone_targets, fallback to mapping_zone_targets
  let zoneTargetRows = await db.collection("ocean_mapping_zone_targets").find({}).toArray();
  if (!zoneTargetRows || zoneTargetRows.length === 0) {
    zoneTargetRows = await db.collection("mapping_zone_targets").find({}).toArray();
  }
  zoneTargetRows.sort((a,b) => new Date(a._insertedAt||0) - new Date(b._insertedAt||0));
  const zoneTargetsByFY = { FY26: {}, FY27: {} };
  for (const row of zoneTargetRows) {
    const zone = String(row["Zone"] || "").trim();
    if (!zone) continue;
    const fy = (row._fy === "FY27") ? "FY27" : "FY26";
    if (!zoneTargetsByFY[fy]) zoneTargetsByFY[fy] = {};
    const zTgtINR = parseFloat(row["Monthly Target (INR)"] || 0) || 0;
    const zTgtUSD = (parseFloat(row["Monthly Target (USD)"] || 0) || 0) * USD_TO_INR;
    const newMonthlyTarget = zTgtINR > 0 ? zTgtINR : zTgtUSD;
    const existing = zoneTargetsByFY[fy][zone];
    if (existing && existing.monthlyTarget > 0 && newMonthlyTarget === 0) continue;
    const yearlyINR  = parseFloat(row["Yearly Target (INR)"]  || 0) || 0;
    const yearlyUSD  = (parseFloat(row["Yearly Target (USD)"] || 0) || 0) * USD_TO_INR;
    const finalYearly = yearlyINR > 0 ? yearlyINR : yearlyUSD;
    const weeklyINR  = parseFloat(row["Weekly Target (INR)"]  || 0) || 0;
    const weeklyUSD  = (parseFloat(row["Weekly Target (USD)"] || 0) || 0) * USD_TO_INR;
    const finalWeekly = weeklyINR > 0 ? weeklyINR : weeklyUSD;
    // Daily = explicit col, or derive from yearly/365
    const dailyINR   = parseFloat(row["Daily Target (INR)"]   || 0) || (finalYearly ? finalYearly / 365 : 0);
    // Zonal Manager: display name — must match Display Name in sales rep mapping
    const zonalMgr   = String(row["Zonal Manager"] || "").split("|")[0].trim();
    zoneTargetsByFY[fy][zone] = {
      yearlyTarget:  finalYearly,
      monthlyTarget: newMonthlyTarget,
      weeklyTarget:  finalWeekly,
      dailyTarget:   dailyINR,
      zonalManager:  zonalMgr,
    };
  }

  // 3. Aggregate job data per rep per month
  const repMonthData = {};
  const repMeta      = {};
  const unmapped     = {};

  const CROSS_SALES_ZONE = "Cross Sales";
  const branchMonthData = {}; // branchName → { monthLabel → { gp, ship, tons, teu, lcl } }
  const repWeekData   = {}; // repKey → { "2026-W14" → { gp, ship, tons, teu, lcl }, ... }
  const branchWeekData= {}; // branchName → { "2026-W14" → { gp, ship, tons, teu, lcl }, ... }
  const repLobData    = {}; // repKey → { "SEA EXPORT" → { "Apr-25" → {gp,ship,tons,teu,lcl} } }
  const branchLobData = {}; // branchName → { "SEA EXPORT" → { "Apr-25" → {...} } }

  // Fetch all collections IN PARALLEL — no DB-level date filter since dates may be in
  // DD/MM/YYYY format which breaks string comparison. parseSheetDate handles filtering in memory.
  const allJobResults = await Promise.all(JOB_COLLECTIONS.map(cn =>
    db.collection(cn).find({}, { projection: {
      "Sales Person":1, "Job Date":1, "LOB":1, "Location":1, "Customer":1,
      "Actual Profit (J=C-G)":1, "Provisional Profit (I=A-E)":1,
      "Financial Lock":1, "Operation Lock":1,
      "ETD Loading Port":1, "ETA Discharge":1,
      "Chargeable Weight":1, "Chargeable Weight Unit":1,
      "Container TEU":1, "Volume":1, "Volume Unit":1, "Cargo Type":1,
    }}).toArray().then(rows => ({ collName: cn, jobs: rows }))
  ));

  for (const { collName, jobs } of allJobResults) {

    for (const job of jobs) {
      const salesPerson = normalizeName(job["Sales Person"]) || "no rep assigned";

      // Classify this row by its own LOB column (or _tab for ISO Tank),
      // NOT by which collection it happens to be stored in — protects
      // against rows that were misfiled into the wrong sheet tab.
      const cls = classifyRow(job, collName);
      const dateCol = getDateColumnFor(cls);

      // Use ETD/ETA only — no Job Date fallback. Jobs with blank ETD/ETA are excluded.
      const primaryDate = job[dateCol];
      if (!primaryDate) continue;
      const d = parseSheetDate(primaryDate);
      if (!d) continue;
      const monthLabel = MONTH_NAMES[d.getMonth()] + "-" + String(d.getFullYear()).slice(2);
      if (!FY_MONTHS.includes(monthLabel)) continue;
      const rowDate = d;

      // Pick the mapping for this row's FY — fall back to the other FY if not found
      // Many reps only have FY26 mapping even if they have FY27 job data
      const rowFY = fyForMonthLabel(monthLabel);
      const mapped = repLookupByFY[rowFY]?.[salesPerson]
                  || repLookupByFY[rowFY === 'FY27' ? 'FY26' : 'FY27']?.[salesPerson];

      const { gp, isProvisional } = pickGP(job, cls);
      const gpProv   = isProvisional ? gp : 0;
      const gpActual = isProvisional ? 0 : gp;

      // Tons — only for AIR rows, Chargeable Weight (kg) ÷ 1000
      let tons = 0;
      if (isAirRow(cls)) {
        const rawWeight = parseFloat(job["Chargeable Weight"] || 0) || 0;
        const unit = String(job["Chargeable Weight Unit"] || "").toLowerCase().trim();
        // Assume kg unless explicitly marked as already in tons/lb
        if (unit === "ton" || unit === "tons" || unit === "mt") {
          tons = rawWeight;
        } else if (unit === "lb" || unit === "lbs") {
          tons = rawWeight * 0.000453592;
        } else {
          tons = rawWeight / 1000; // default: kg → tons
        }
      }

      // TEU / LCL(CBM) — only for SEA and ISOTANK rows, but WHICH of the two
      // a row contributes to is decided by its Cargo Type, not its LOB kind:
      //   Cargo Type = FCL or "Liquid (Cont)" → Container TEU column
      //   Cargo Type = LCL                    → Volume column (assumed CBM)
      let teu = 0;
      let lcl = 0;
      if (hasTeuLclRow(cls)) {
        const cargoMetric = cargoMetricFor(job);
        if (cargoMetric === "TEU") {
          teu = parseFloat(job["Container TEU"] || 0) || 0;
        } else if (cargoMetric === "LCL") {
          const vol = parseFloat(job["Volume"] || 0) || 0;
          const volUnit = String(job["Volume Unit"] || "").toUpperCase().trim();
          // Only count as LCL(CBM) if the unit is actually CBM (or blank, assumed CBM)
          if (!volUnit || volUnit === "CBM") lcl = vol;
        }
      }

      if (!mapped) {
        // Unmapped sales person → Cross Sales, grouped by branch (Location)
        unmapped[job["Sales Person"]] = (unmapped[job["Sales Person"]] || 0) + 1;

        const branch = String(job["Location"] || "Unspecified").trim() || "Unspecified";
        if (!branchMonthData[branch]) branchMonthData[branch] = {};
        if (!branchMonthData[branch][monthLabel]) branchMonthData[branch][monthLabel] = { gp: 0, gpProv: 0, gpActual: 0, ship: 0, tons: 0, teu: 0, lcl: 0 };
        branchMonthData[branch][monthLabel].gp   += gp;
        branchMonthData[branch][monthLabel].gpProv   += gpProv;
        branchMonthData[branch][monthLabel].gpActual += gpActual;
        branchMonthData[branch][monthLabel].ship += 1;
        branchMonthData[branch][monthLabel].tons += tons;
        branchMonthData[branch][monthLabel].teu  += teu;
        branchMonthData[branch][monthLabel].lcl  += lcl;
        // Weekly accumulation — keyed by true ISO week (Mon-Sun), e.g. "2026-W14"
        if (rowDate) {
          const wk = isoWeekInfo(rowDate).key;
          if (!branchWeekData[branch]) branchWeekData[branch] = {};
          if (!branchWeekData[branch][wk]) branchWeekData[branch][wk] = { gp:0, gpProv:0, gpActual:0, ship:0, tons:0, teu:0, lcl:0 };
          branchWeekData[branch][wk].gp += gp; branchWeekData[branch][wk].gpProv += gpProv; branchWeekData[branch][wk].gpActual += gpActual; branchWeekData[branch][wk].ship += 1;
          branchWeekData[branch][wk].tons += tons; branchWeekData[branch][wk].teu += teu; branchWeekData[branch][wk].lcl += lcl;
        }
        // LOB accumulation (Sea Export/Import, ISOTANK Export/Import, Air Export/Import)
        {
          const lobKey = cls.kind + (cls.direction ? " " + cls.direction : "");
          if (!branchLobData[branch]) branchLobData[branch] = {};
          if (!branchLobData[branch][lobKey]) branchLobData[branch][lobKey] = {};
          if (!branchLobData[branch][lobKey][monthLabel]) branchLobData[branch][lobKey][monthLabel] = { gp:0, gpProv:0, gpActual:0, ship:0, tons:0, teu:0, lcl:0 };
          branchLobData[branch][lobKey][monthLabel].gp   += gp;
          branchLobData[branch][lobKey][monthLabel].gpProv   += gpProv;
          branchLobData[branch][lobKey][monthLabel].gpActual += gpActual;
          branchLobData[branch][lobKey][monthLabel].ship += 1;
          branchLobData[branch][lobKey][monthLabel].tons += tons;
          branchLobData[branch][lobKey][monthLabel].teu  += teu;
          branchLobData[branch][lobKey][monthLabel].lcl  += lcl;
        }
        continue;
      }

      const repKey = mapped.displayName + "||" + mapped.zone;

      if (!repMonthData[repKey]) repMonthData[repKey] = {};
      if (!repMonthData[repKey][monthLabel]) repMonthData[repKey][monthLabel] = { gp: 0, gpProv: 0, gpActual: 0, ship: 0, tons: 0, teu: 0, lcl: 0 };
      repMonthData[repKey][monthLabel].gp   += gp;
      repMonthData[repKey][monthLabel].gpProv   += gpProv;
      repMonthData[repKey][monthLabel].gpActual += gpActual;
      repMonthData[repKey][monthLabel].ship += 1;
      repMonthData[repKey][monthLabel].tons += tons;
      repMonthData[repKey][monthLabel].teu  += teu;
      repMonthData[repKey][monthLabel].lcl  += lcl;
      // Weekly accumulation — keyed by true ISO week (Mon-Sun), e.g. "2026-W14"
      if (rowDate) {
        const wk = isoWeekInfo(rowDate).key;
        if (!repWeekData[repKey]) repWeekData[repKey] = {};
        if (!repWeekData[repKey][wk]) repWeekData[repKey][wk] = { gp:0, gpProv:0, gpActual:0, ship:0, tons:0, teu:0, lcl:0 };
        repWeekData[repKey][wk].gp += gp; repWeekData[repKey][wk].gpProv += gpProv; repWeekData[repKey][wk].gpActual += gpActual; repWeekData[repKey][wk].ship += 1;
        repWeekData[repKey][wk].tons += tons; repWeekData[repKey][wk].teu += teu; repWeekData[repKey][wk].lcl += lcl;
      }
      // LOB accumulation (monthly + weekly)
      {
        const lobKey = cls.kind + (cls.direction ? " " + cls.direction : "");
        if (!repLobData[repKey]) repLobData[repKey] = {};
        if (!repLobData[repKey][lobKey]) repLobData[repKey][lobKey] = {};
        if (!repLobData[repKey][lobKey][monthLabel]) repLobData[repKey][lobKey][monthLabel] = { gp:0, gpProv:0, gpActual:0, ship:0, tons:0, teu:0, lcl:0 };
        repLobData[repKey][lobKey][monthLabel].gp   += gp;
        repLobData[repKey][lobKey][monthLabel].gpProv   += gpProv;
        repLobData[repKey][lobKey][monthLabel].gpActual += gpActual;
        repLobData[repKey][lobKey][monthLabel].ship += 1;
        repLobData[repKey][lobKey][monthLabel].tons += tons;
        repLobData[repKey][lobKey][monthLabel].teu  += teu;
        repLobData[repKey][lobKey][monthLabel].lcl  += lcl;
        // Week-level LOB data for LOB-filtered weekly view
        if (rowDate) {
          const wk = isoWeekInfo(rowDate).key;
          if (!repLobData[repKey][lobKey]._week) repLobData[repKey][lobKey]._week = {};
          if (!repLobData[repKey][lobKey]._week[wk]) repLobData[repKey][lobKey]._week[wk] = { gp:0, gpProv:0, gpActual:0, ship:0, tons:0, teu:0, lcl:0 };
          repLobData[repKey][lobKey]._week[wk].gp += gp;
          repLobData[repKey][lobKey]._week[wk].gpProv += gpProv;
          repLobData[repKey][lobKey]._week[wk].gpActual += gpActual;
          repLobData[repKey][lobKey]._week[wk].ship += 1;
          repLobData[repKey][lobKey]._week[wk].tons += tons;
          repLobData[repKey][lobKey]._week[wk].teu += teu;
          repLobData[repKey][lobKey]._week[wk].lcl += lcl;
        }
      }

      if (!repMeta[repKey]) repMeta[repKey] = mapped;
    }
  }

  // 4. Shape into repsRaw
  const activeMonths = FY_MONTHS.filter(m =>
    Object.values(repMonthData).some(d => d[m]) ||
    Object.values(branchMonthData).some(d => d[m])
  );

  const repsRaw = [];
  for (const [repKey, monthData] of Object.entries(repMonthData)) {
    const meta = repMeta[repKey];
    if (!meta) continue; // skip reps in job data but missing from mapping sheet

    const gp      = activeMonths.map(m => monthData[m]?.gp      || 0);
    const gpProv  = activeMonths.map(m => monthData[m]?.gpProv  || 0);
    const gpActual= activeMonths.map(m => monthData[m]?.gpActual|| 0);
    const ship = activeMonths.map(m => monthData[m]?.ship || 0);
    const tons = activeMonths.map(m => Math.round((monthData[m]?.tons || 0) * 100) / 100);
    const teu  = activeMonths.map(m => Math.round((monthData[m]?.teu  || 0) * 100) / 100);
    const lcl  = activeMonths.map(m => Math.round((monthData[m]?.lcl  || 0) * 100) / 100);

    // Use rep's own targets directly from the mapping sheet
    const repTgt = meta.monthlyTarget || 0;

    repsRaw.push({
      name:  meta.displayName,
      zone:  meta.zone,
      lob:   meta.lob,
      email: meta.email,
      hue:   zoneHue(meta.zone),
      gp, gpProv, gpActual, ship, tons, teu, lcl,
      tank:  activeMonths.map(() => 0),
      tgt:          repTgt,
      weeklyTgt:    meta.weeklyTarget  || 0,
      yearlyTgt:    meta.yearlyTarget  || 0,
      dailyTgt:     meta.dailyTarget   || 0,
      joinDate:     meta.joinDate && !isNaN(meta.joinDate) ? meta.joinDate.toISOString().slice(0,10) : null,
      exitDate:     meta.exitDate && !isNaN(meta.exitDate) ? meta.exitDate.toISOString().slice(0,10) : null,
      weekData: repWeekData[repKey] || {},
      lobData: repLobData[repKey] || {},
    });
  }

  // Cross Sales branches
  for (const [branchName, monthData] of Object.entries(branchMonthData)) {
    const gp      = activeMonths.map(m => monthData[m]?.gp      || 0);
    const gpProv  = activeMonths.map(m => monthData[m]?.gpProv  || 0);
    const gpActual= activeMonths.map(m => monthData[m]?.gpActual|| 0);
    const ship = activeMonths.map(m => monthData[m]?.ship || 0);
    const tons = activeMonths.map(m => Math.round((monthData[m]?.tons || 0) * 100) / 100);
    const teu  = activeMonths.map(m => Math.round((monthData[m]?.teu  || 0) * 100) / 100);
    const lcl  = activeMonths.map(m => Math.round((monthData[m]?.lcl  || 0) * 100) / 100);

    repsRaw.push({
      name:  branchName,
      zone:  CROSS_SALES_ZONE,
      lob:   "",
      email: "",
      hue:   zoneHue(CROSS_SALES_ZONE + branchName),
      gp, gpProv, gpActual, ship, tons, teu, lcl,
      tank:  activeMonths.map(() => 0),
      tgt:   0,
      isBranch: true,
      weekData: branchWeekData[branchName] || {},
      lobData: branchLobData[branchName] || {},
    });
  }

  repsRaw.sort((a, b) => {
    // Cross Sales always sorts last, after every real zone
    if (a.zone === CROSS_SALES_ZONE && b.zone !== CROSS_SALES_ZONE) return 1;
    if (b.zone === CROSS_SALES_ZONE && a.zone !== CROSS_SALES_ZONE) return -1;
    if (a.zone !== b.zone) return a.zone.localeCompare(b.zone);
    const aGP = a.gp.reduce((s, v) => s + v, 0);
    const bGP = b.gp.reduce((s, v) => s + v, 0);
    return bGP - aGP;
  });

  // 5. Build zone summaries + compute zonal manager target as remainder
  const zonesMap = {};
  for (const rep of repsRaw) {
    if (!zonesMap[rep.zone]) {
      const fy27Target = zoneTargetsByFY.FY27[rep.zone];
      const fy26Target = zoneTargetsByFY.FY26[rep.zone];
      const chosenTarget = fy27Target || fy26Target || {};
      zonesMap[rep.zone] = {
        zone: rep.zone,
        monthlyTarget: chosenTarget.monthlyTarget || 0,
        yearlyTarget:  chosenTarget.yearlyTarget  || 0,
        weeklyTarget:  chosenTarget.weeklyTarget  || 0,
        dailyTarget:   chosenTarget.dailyTarget   || 0,
        zonalManager:  chosenTarget.zonalManager  || "",
        gp:   activeMonths.map(() => 0),
        ship: activeMonths.map(() => 0),
        tons: activeMonths.map(() => 0),
        teu:  activeMonths.map(() => 0),
        lcl:  activeMonths.map(() => 0),
      };
    }
    rep.gp.forEach((v, i)   => { zonesMap[rep.zone].gp[i]   += v; });
    rep.ship.forEach((v, i) => { zonesMap[rep.zone].ship[i] += v; });
    rep.tons.forEach((v, i) => { zonesMap[rep.zone].tons[i] += v; });
    rep.teu.forEach((v, i)  => { zonesMap[rep.zone].teu[i]  += v; });
    rep.lcl.forEach((v, i)  => { zonesMap[rep.zone].lcl[i]  += v; });
  }

  // Zone targets come directly from mapping_zone_targets (already in zonesMap).
  // Rep targets (including Zonal Manager) come directly from mapping_sales_targets.
  // They are independent — rep targets do NOT need to add up to zone target.


  return {
    success:  true,
    months:   activeMonths,
    repsRaw,
    zones:    Object.values(zonesMap),
    unmapped: Object.entries(unmapped)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count })),
    pushedAt: new Date().toISOString(),
  };
}

// In-memory cache for customer aggregate
const customerCacheMap = {}; // key → { data, time }

// Used by Customer Insights
const CUSTOMER_INSIGHTS_COLLECTIONS = ["jobs_air_export", "jobs_air_import"];

async function getCustomerAggregate(db, force, dateFrom, dateTo, cacheKey) {
  const key = cacheKey || 'all';
  const entry = customerCacheMap[key];
  if (!force && entry && (Date.now() - entry.time) < SALES_CACHE_TTL_MS) {
    return { ...entry.data, cached: true };
  }
  const result = await computeCustomerAggregate(db, dateFrom, dateTo);
  customerCacheMap[key] = { data: result, time: Date.now() };
  return result;
}

async function computeCustomerAggregate(db, dateFrom, dateTo) {
  // Parse active month labels from dateFrom/dateTo (e.g. "Jan-26" to "Jun-26")
  const FY_MONTHS_LIST = ["Apr-25","May-25","Jun-25","Jul-25","Aug-25","Sep-25",
    "Oct-25","Nov-25","Dec-25","Jan-26","Feb-26","Mar-26",
    "Apr-26","May-26","Jun-26","Jul-26","Aug-26","Sep-26",
    "Oct-26","Nov-26","Dec-26","Jan-27","Feb-27","Mar-27"];
  let activeMonthSet = null;
  if (dateFrom && dateTo) {
    const fi = FY_MONTHS_LIST.indexOf(dateFrom);
    const ti = FY_MONTHS_LIST.indexOf(dateTo);
    if (fi >= 0 && ti >= 0) {
      activeMonthSet = new Set(FY_MONTHS_LIST.slice(fi, ti + 1));
    }
  }
  // LOB groups for customer insights
  const LOB_GROUPS = {
    "Air":      ["jobs_air_export",      "jobs_air_import"],
    "Ocean":    ["jobs_sea_export",      "jobs_sea_import"],
    "ISO Tank": ["jobs_isotank_export",  "jobs_isotank_import"],
  };
  const ALL_COLLS = Object.values(LOB_GROUPS).flat();

  // custMapByLob: lob → customer → { shipments, revenue, gp, tons }
  const custMapByLob = { "Air": {}, "Ocean": {}, "ISO Tank": {} };
  const custMapAll   = {};
  // salesRepMap: customer → Set of sales rep display names
  const custSalesReps = {};
  const custRepMap = {}; // customer → rep → {shipments,revenue,gp,tons,teu}
  // lobsMap: customer → Set of lob sub-labels (e.g. "Air Exp", "Sea Imp")
  const custLobLabels = {};

  const projection = {
    "Customer": 1, "Billed Revenue (C)": 1,
    "Actual Profit (J=C-G)": 1, "Provisional Profit (I=A-E)": 1,
    "Sales Person": 1,
    "Financial Lock": 1, "Operation Lock": 1,
    "Chargeable Weight": 1, "Chargeable Weight Unit": 1,
    "Container TEU": 1, "Volume": 1, "Volume Unit": 1,
    "ETD Loading Port": 1, "ETA Discharge": 1, "Job Date": 1,
  };

  await Promise.all(ALL_COLLS.map(async (collName) => {
    const lob = collName.includes("air") ? "Air"
              : collName.includes("isotank") ? "ISO Tank"
              : "Ocean";
    const isAir = lob === "Air";
    const cls = {
      kind: isAir ? "AIR" : collName.includes("isotank") ? "ISOTANK" : "SEA",
      direction: collName.includes("import") ? "IMPORT" : "EXPORT"
    };

    const jobs = await db.collection(collName).find({}, { projection }).toArray();

    const isExportColl = collName.includes("export");
    const isImportColl = collName.includes("import");
    const dateCol = isExportColl ? "ETD Loading Port" : isImportColl ? "ETA Discharge" : "Job Date";

    for (const job of jobs) {
      // Date filter — only include jobs within the selected month range
      if (activeMonthSet) {
        const rawDate = job[dateCol]; // ETD/ETA only — no Job Date fallback (matches getDrillRows)
        if (!rawDate) continue;
        const dObj = parseSheetDate(rawDate);
        if (!dObj) continue;
        const ml = MONTH_NAMES[dObj.getMonth()] + "-" + String(dObj.getFullYear()).slice(2);
        if (!activeMonthSet.has(ml)) continue;
      }

      const customer = String(job["Customer"] || "").trim();
      if (!customer) continue;
      const revenue = parseFloat(job["Billed Revenue (C)"] || 0) || 0;
      const { gp } = pickGP(job, cls);

      // Tons for Air only
      let tons = 0;
      if (isAir) {
        const rawW = parseFloat(job["Chargeable Weight"] || 0) || 0;
        const wUnit = String(job["Chargeable Weight Unit"] || "").toLowerCase().trim();
        if (wUnit === "ton" || wUnit === "tons" || wUnit === "mt") tons = rawW;
        else if (wUnit === "lb" || wUnit === "lbs") tons = rawW * 0.000453592;
        else tons = rawW / 1000;
      }

      // TEU for Ocean/ISO Tank
      let teu = 0;
      if (!isAir) {
        teu = parseFloat(job["Container TEU"] || 0) || 0;
      }

      // Derive month label for this job
      const rawDateForMl = job[dateCol];
      let monthLabelForMd = "";
      if (rawDateForMl) {
        const dMl = parseSheetDate(rawDateForMl);
        if (dMl) monthLabelForMd = MONTH_NAMES[dMl.getMonth()] + "-" + String(dMl.getFullYear()).slice(2);
      }

      function addTo(map, key) {
        if (!map[key]) map[key] = { shipments:0, revenue:0, gp:0, tons:0, teu:0, monthData:{} };
        map[key].shipments++; map[key].revenue += revenue; map[key].gp += gp;
        map[key].tons += tons; map[key].teu += teu;
        if (monthLabelForMd) {
          if (!map[key].monthData[monthLabelForMd]) map[key].monthData[monthLabelForMd] = { shipments:0, revenue:0, gp:0, tons:0, teu:0 };
          map[key].monthData[monthLabelForMd].shipments++;
          map[key].monthData[monthLabelForMd].revenue += revenue;
          map[key].monthData[monthLabelForMd].gp += gp;
          map[key].monthData[monthLabelForMd].tons += tons;
          map[key].monthData[monthLabelForMd].teu += teu;
        }
      }
      addTo(custMapByLob[lob], customer);
      addTo(custMapAll, customer);

      // Track sales reps (first pipe segment = display name)
      const rawSP = String(job["Sales Person"] || "").trim();
      const dispSP = rawSP ? rawSP.split("|")[0].trim() : "";
      if (dispSP) {
        if (!custSalesReps[customer]) custSalesReps[customer] = new Set();
        custSalesReps[customer].add(dispSP);
        // Per-rep metrics for zone-scoped filtering
        if (!custRepMap[customer]) custRepMap[customer] = {};
        if (!custRepMap[customer][dispSP]) custRepMap[customer][dispSP] = { shipments:0, revenue:0, gp:0, tons:0, teu:0 };
        custRepMap[customer][dispSP].shipments++;
        custRepMap[customer][dispSP].revenue += revenue;
        custRepMap[customer][dispSP].gp += gp;
        custRepMap[customer][dispSP].tons += tons;
        custRepMap[customer][dispSP].teu += teu;
      }
      // Track LOB sub-labels
      const lobLabel = lob === "Air"
        ? (collName.includes("import") ? "Air Imp" : "Air Exp")
        : lob === "ISO Tank"
          ? (collName.includes("import") ? "ISO Imp" : "ISO Exp")
          : (collName.includes("import") ? "Sea Imp" : "Sea Exp");
      if (!custLobLabels[customer]) custLobLabels[customer] = new Set();
      custLobLabels[customer].add(lobLabel);
    }
  }));

  function buildStats(custMap) {
    const customers = Object.entries(custMap).map(([name, d]) => ({
      name,
      shipments: d.shipments,
      revenue:   Math.round(d.revenue),
      gp:        Math.round(d.gp),
      tons:      Math.round(d.tons * 100) / 100,
      teu:       Math.round(d.teu * 100) / 100,
      gpPct:     d.revenue > 0 ? Math.round((d.gp / d.revenue) * 1000) / 10 : 0,
      salesReps: custSalesReps[name] ? [...custSalesReps[name]] : [],
      lobs:      custLobLabels[name] ? [...custLobLabels[name]].sort() : [],
      repMetrics: custRepMap[name] || {},
      monthData: Object.fromEntries(Object.entries(d.monthData||{}).map(([m,md])=>[m,{shipments:md.shipments,revenue:Math.round(md.revenue),gp:Math.round(md.gp),tons:Math.round(md.tons*100)/100,teu:Math.round(md.teu*100)/100}])),
    }));
    function top10(arr, key) { return [...arr].sort((a,b)=>b[key]-a[key]).slice(0,10); }
    return {
      topByShipments: top10(customers, "shipments"),
      topByRevenue:   top10(customers, "revenue"),
      topByGP:        top10(customers, "gp"),
      topByTons:      top10(customers.filter(c=>c.tons>0), "tons"),
      topByTEU:       top10(customers.filter(c=>c.teu>0), "teu"),
      topByGPPct:     top10(customers.filter(c=>c.shipments>=2), "gpPct"),
      totalCustomers: customers.length,
      allCustomers:   [...customers].sort((a,b)=>b.gp-a.gp), // full list sorted by GP for pivot
    };
  }

  return {
    success: true,
    lobs: {
      "Air":      buildStats(custMapByLob["Air"]),
      "Ocean":    buildStats(custMapByLob["Ocean"]),
      "ISO Tank": buildStats(custMapByLob["ISO Tank"]),
    },
    // "All" = combined across all LOBs
    ...buildStats(custMapAll),
    pushedAt: new Date().toISOString(),
  };
}

// ─── Agent Insights ───────────────────────────────────────────────────────────
const agentCacheMap = {}; // key → { data, time }

// ─── Tradelane Insights ───────────────────────────────────────────────────────
const tradelaneCacheMap = {}; // key → { data, time }

// ── Port code → Country + Tradelane lookup (from "Tradelane Mapping" sheet) ──
// iso2 → { country, tradelane }
const TRADELANE_MAP = {
  "US":{"country":"United States","tradelane":"US"},
  "GB":{"country":"United Kingdom","tradelane":"Europe"},
  "CA":{"country":"Canada","tradelane":"Canada"},
  "PR":{"country":"Puerto Rico","tradelane":"LATAM"},
  "BR":{"country":"Brazil","tradelane":"LATAM"},
  "VN":{"country":"Viet Nam","tradelane":"Asia"},
  "MX":{"country":"Mexico","tradelane":"LATAM"},
  "FR":{"country":"France","tradelane":"Med"},
  "BE":{"country":"Belgium","tradelane":"Europe"},
  "GE":{"country":"Georgia","tradelane":"Europe"},
  "DE":{"country":"Germany","tradelane":"Europe"},
  "NL":{"country":"Netherlands","tradelane":"Europe"},
  "PY":{"country":"Paraguay","tradelane":"LATAM"},
  "TR":{"country":"Turkey","tradelane":"Med"},
  "ES":{"country":"Spain","tradelane":"Med"},
  "ID":{"country":"Indonesia","tradelane":"Asia"},
  "SG":{"country":"Singapore","tradelane":"Asia"},
  "OM":{"country":"Oman","tradelane":"Middle East"},
  "FI":{"country":"Finland","tradelane":"Europe"},
  "EG":{"country":"Egypt","tradelane":"Med"},
  "MA":{"country":"Morocco","tradelane":"Med"},
  "AE":{"country":"United Arab Emirates","tradelane":"Middle East"},
  "TN":{"country":"Tunisia","tradelane":"Med"},
  "ZA":{"country":"South Africa","tradelane":"Africa"},
  "GH":{"country":"Ghana","tradelane":"Africa"},
  "CN":{"country":"China","tradelane":"Asia"},
  "HN":{"country":"Honduras","tradelane":"LATAM"},
  "PE":{"country":"Peru","tradelane":"LATAM"},
  "DO":{"country":"Dominican Republic","tradelane":"Dominican Republic"},
  "PK":{"country":"Pakistan","tradelane":"Asia"},
  "KE":{"country":"Kenya","tradelane":"Africa"},
  "MR":{"country":"Mauritania","tradelane":"Africa"},
  "IT":{"country":"Italy","tradelane":"Med"},
  "RU":{"country":"Russian Federation","tradelane":"Asia"},
  "LK":{"country":"Sri Lanka","tradelane":"Asia"},
  "DZ":{"country":"Algeria","tradelane":"Med"},
  "PL":{"country":"Poland","tradelane":"Europe"},
  "GY":{"country":"Guyana","tradelane":"LATAM"},
  "JP":{"country":"Japan","tradelane":"Asia"},
  "BD":{"country":"Bangladesh","tradelane":"Asia"},
  "AU":{"country":"Australia","tradelane":"Oceania"},
  "KR":{"country":"South Korea","tradelane":"Asia"},
  "NZ":{"country":"New Zealand","tradelane":"Oceania"},
  "HR":{"country":"Croatia","tradelane":"Europe"},
  "IL":{"country":"Israel","tradelane":"Med"},
  "CL":{"country":"Chile","tradelane":"LATAM"},
  "PT":{"country":"Portugal","tradelane":"Europe"},
  "PA":{"country":"Panama","tradelane":"LATAM"},
  "JO":{"country":"Jordan","tradelane":"Middle East"},
  "NG":{"country":"Nigeria","tradelane":"Africa"},
  "SA":{"country":"Saudi Arabia","tradelane":"Middle East"},
  "SO":{"country":"Somalia","tradelane":"Africa"},
  "KW":{"country":"Kuwait","tradelane":"Middle East"},
  "LY":{"country":"Libya","tradelane":"Med"},
  "AR":{"country":"Argentina","tradelane":"LATAM"},
  "SE":{"country":"Sweden","tradelane":"Europe"},
  "EE":{"country":"Estonia","tradelane":"Europe"},
  "LT":{"country":"Lithuania","tradelane":"Europe"},
  "NO":{"country":"Norway","tradelane":"Europe"},
  "DK":{"country":"Denmark","tradelane":"Europe"},
  "LV":{"country":"Latvia","tradelane":"Europe"},
  "IE":{"country":"Ireland","tradelane":"Europe"},
  "EC":{"country":"Ecuador","tradelane":"LATAM"},
  "CI":{"country":"Cote d'Ivoire","tradelane":"Africa"},
  "GT":{"country":"Guatemala","tradelane":"LATAM"},
  "DJ":{"country":"Djibouti","tradelane":"Middle East"},
  "SL":{"country":"Sierra Leone","tradelane":"Africa"},
  "CO":{"country":"Colombia","tradelane":"LATAM"},
  "TH":{"country":"Thailand","tradelane":"Asia"},
  "TZ":{"country":"Tanzania","tradelane":"Africa"},
  "MZ":{"country":"Mozambique","tradelane":"Africa"},
  "BG":{"country":"Bulgaria","tradelane":"Europe"},
  "MM":{"country":"Myanmar","tradelane":"Asia"},
  "MV":{"country":"Maldives","tradelane":"Indian Subcontinent"},
  "SI":{"country":"Slovenia","tradelane":"Europe"},
  "MY":{"country":"Malaysia","tradelane":"Asia"},
  "IR":{"country":"Iran","tradelane":"Middle East"},
  "UY":{"country":"Uruguay","tradelane":"LATAM"},
  "YE":{"country":"Yemen","tradelane":"Middle East"},
  "CY":{"country":"Cyprus","tradelane":"Med"},
  "GR":{"country":"Greece","tradelane":"Med"},
  "PH":{"country":"Philippines","tradelane":"Asia"},
  "TW":{"country":"Taiwan","tradelane":"Asia"},
  "QA":{"country":"Qatar","tradelane":"Middle East"},
  "LB":{"country":"Lebanon","tradelane":"Med"},
  "SV":{"country":"El Salvador","tradelane":"LATAM"},
  "MU":{"country":"Mauritius","tradelane":"Middle East"},
  "CG":{"country":"Congo","tradelane":"Africa"},
  "FJ":{"country":"Fiji","tradelane":"Oceania"},
  "CM":{"country":"Cameroon","tradelane":"Africa"},
  "CD":{"country":"DR Congo","tradelane":"Africa"},
  "SR":{"country":"Suriname","tradelane":"LATAM"},
  "BB":{"country":"Barbados","tradelane":"LATAM"},
  "UA":{"country":"Ukraine","tradelane":"Europe"},
  "RO":{"country":"Romania","tradelane":"Europe"},
  "CU":{"country":"Cuba","tradelane":"LATAM"},
  "TG":{"country":"Togo","tradelane":"Africa"},
  "CR":{"country":"Costa Rica","tradelane":"LATAM"},
  "ZM":{"country":"Zambia","tradelane":"Africa"},
  "HK":{"country":"Hong Kong","tradelane":"Asia"},
  "SK":{"country":"Slovakia","tradelane":"Others"},
  "IQ":{"country":"Iraq","tradelane":"Middle East"},
  "SC":{"country":"Seychelles","tradelane":"Africa"},
  "BH":{"country":"Bahrain","tradelane":"Middle East"},
  "JM":{"country":"Jamaica","tradelane":"LATAM"},
  "BJ":{"country":"Benin","tradelane":"Africa"},
  "BN":{"country":"Brunei","tradelane":"Asia"},
  "AO":{"country":"Angola","tradelane":"Africa"},
  "SD":{"country":"Sudan","tradelane":"Middle East"},
  "TT":{"country":"Trinidad and Tobago","tradelane":"LATAM"},
  "BZ":{"country":"Belize","tradelane":"LATAM"},
  "BS":{"country":"Bahamas","tradelane":"LATAM"},
  "GP":{"country":"Guadeloupe","tradelane":"LATAM"},
  "SY":{"country":"Syria","tradelane":"Middle East"},
  "VE":{"country":"Venezuela","tradelane":"LATAM"},
  "BF":{"country":"Burkina Faso","tradelane":"Africa"},
  "IN":{"country":"India","tradelane":"Asia"},
  "MG":{"country":"Madagascar","tradelane":"Africa"},
  "KM":{"country":"Comoros","tradelane":"Africa"},
  "CZ":{"country":"Czechia","tradelane":"Europe"},
  "SN":{"country":"Senegal","tradelane":"Africa"},
  "BI":{"country":"Burundi","tradelane":"Africa"},
  "KZ":{"country":"Kazakhstan","tradelane":"Asia"},
  "ME":{"country":"Montenegro","tradelane":"Europe"},
  "NI":{"country":"Nicaragua","tradelane":"LATAM"},
  "HT":{"country":"Haiti","tradelane":"LATAM"},
  "BM":{"country":"Bermuda","tradelane":"Europe"},
  "GM":{"country":"Gambia","tradelane":"Africa"},
  "NA":{"country":"Namibia","tradelane":"Africa"},
  "MT":{"country":"Malta","tradelane":"Europe"},
  "KH":{"country":"Cambodia","tradelane":"Asia"},
  "AQ":{"country":"Antarctica","tradelane":"Others"},
  "LR":{"country":"Liberia","tradelane":"Africa"},
  "YT":{"country":"Mayotte","tradelane":"Africa"},
  "HU":{"country":"Hungary","tradelane":"Europe"},
  "GD":{"country":"Grenada","tradelane":"LATAM"},
  "CH":{"country":"Switzerland","tradelane":"Europe"},
  "RE":{"country":"Reunion","tradelane":"LATAM"},
  "LC":{"country":"Saint Lucia","tradelane":"LATAM"},
  "ZW":{"country":"Zimbabwe","tradelane":"Africa"},
  "GW":{"country":"Guinea-Bissau","tradelane":"Africa"},
  "NP":{"country":"Nepal","tradelane":"Asia"},
  "BW":{"country":"Botswana","tradelane":"Africa"},
  "AT":{"country":"Austria","tradelane":"Europe"},
  "GA":{"country":"Gabon","tradelane":"Africa"},
  "BQ":{"country":"Bonaire","tradelane":"LATAM"},
  "ET":{"country":"Ethiopia","tradelane":"Middle East"},
  "UG":{"country":"Uganda","tradelane":"Africa"},
  "UZ":{"country":"Uzbekistan","tradelane":"Asia"},
  "BY":{"country":"Belarus","tradelane":"Europe"},
  "MW":{"country":"Malawi","tradelane":"Africa"},
  "MK":{"country":"North Macedonia","tradelane":"Europe"},
  "AZ":{"country":"Azerbaijan","tradelane":"Asia"},
  "AM":{"country":"Armenia","tradelane":"Asia"},
  "GN":{"country":"Guinea","tradelane":"Africa"},
  "BA":{"country":"Bosnia and Herzegovina","tradelane":"Europe"},
  "CW":{"country":"Curacao","tradelane":"LATAM"},
  "SX":{"country":"Sint Maarten","tradelane":"LATAM"},
  "BO":{"country":"Bolivia","tradelane":"LATAM"},
  "AF":{"country":"Afghanistan","tradelane":"Asia"},
  "ML":{"country":"Mali","tradelane":"Africa"},
  "SS":{"country":"South Sudan","tradelane":"Middle East"},
  "NE":{"country":"Niger","tradelane":"Africa"},
  "MN":{"country":"Mongolia","tradelane":"Asia"},
  "RS":{"country":"Serbia","tradelane":"Europe"},
  "KG":{"country":"Kyrgyzstan","tradelane":"Asia"},
  "AL":{"country":"Albania","tradelane":"Europe"},
  "LA":{"country":"Laos","tradelane":"Asia"},
  "LU":{"country":"Luxembourg","tradelane":"Europe"},
  "TJ":{"country":"Tajikistan","tradelane":"Asia"},
  "PG":{"country":"Papua New Guinea","tradelane":"Oceania"},
  "GQ":{"country":"Equatorial Guinea","tradelane":"Africa"},
  "DM":{"country":"Dominica","tradelane":"LATAM"},
  "VU":{"country":"Vanuatu","tradelane":"Oceania"},
  "TD":{"country":"Chad","tradelane":"Africa"},
  "MW":{"country":"Malawi","tradelane":"Africa"},
  "LU":{"country":"Luxembourg","tradelane":"Europe"},
  "MO":{"country":"Macao","tradelane":"Asia"},
  "SJ":{"country":"Svalbard","tradelane":"Europe"},
  "FO":{"country":"Faroe Islands","tradelane":"Europe"},
  "IS":{"country":"Iceland","tradelane":"Europe"},
  "GL":{"country":"Greenland","tradelane":"Europe"},
};

// Free-text city/airport name → tradelane (for ports not matched by ISO2 code)
const CITY_TRADELANE_MAP = {
  // Europe
  "aberdeen": "Europe", "goteborg": "Europe", "landvetter": "Europe",
  "brussel (bruxelles)": "Europe", "brussels": "Europe",
  "cologne air port": "Europe", "cologne": "Europe", "koeln": "Europe",
  "dusseldorf": "Europe", "düsseldorf": "Europe",
  "stuttgart": "Europe", "basel": "Europe",
  "lille-lesquin apt": "Europe", "lille": "Europe",
  "marseille": "Europe", "nice": "Europe",
  "saint-exupery apt/lyon": "Europe", "lyon": "Europe",
  "toulouse": "Europe",
  "lisboa": "Europe", "lisbon": "Europe",
  "porto": "Europe",
  "roma": "Europe", "rome": "Europe", "napoli": "Europe", "naples": "Europe",
  "praha": "Europe", "prague": "Europe",
  "warszawa": "Europe", "warsaw": "Europe",
  "wien": "Europe", "vienna": "Europe",
  "otopeni apt/bucuresti": "Europe", "bucharest": "Europe",
  "thessaloniki": "Europe",
  "larnaca": "Europe",
  "riverside park apt/dundee": "Europe", "dundee": "Europe",
  "istanbul": "Med", "gaziantep": "Med", "cukurova international airport": "Med",
  "saint petersburg (ex leningrad)": "Asia", "minsk": "Europe",
  "novosibirsk": "Asia",
  // LATAM
  "ciudad de mexico": "LATAM", "mexico city": "LATAM",
  "felipe angeles international airport": "LATAM",
  "barranquilla": "LATAM", "cali": "LATAM",
  "cancun": "LATAM",
  "techo international airport": "LATAM", "bogota": "LATAM",
  "panama, ciudad de": "LATAM", "panama city": "LATAM",
  "paramaribo": "LATAM",
  "viru viru": "LATAM", "santa cruz": "LATAM",
  "rio de janeiro internacional apt": "LATAM", "rio de janeiro": "LATAM",
  "salvador": "LATAM",
  "sint-maarten apt": "LATAM", "saint kitts": "LATAM",
  "kingston": "LATAM",
  "bridgetown": "LATAM",
  "curacao": "LATAM",
  "port-au-prince": "LATAM",
  "port-of-spain": "LATAM",
  "georgetown": "LATAM",
  // Africa
  "dr. antónio agostinho neto international airport": "Africa", "luanda": "Africa",
  "entebbe": "Africa", "kampala": "Africa",
  "juba": "Africa",
  "durban": "Africa",
  "kano": "Africa",
  "port harcourt": "Africa",
  "freetown": "Africa",
  "conakry": "Africa",
  "bamako": "Africa",
  "banjul": "Africa",
  "blaise diagne international airport": "Africa", "dakar": "Africa",
  "brazzaville": "Africa", "pointe noire": "Africa",
  "bujumbura": "Africa",
  "lilongwe": "Africa",
  "lome": "Africa",
  "niamey": "Africa",
  "n'djamena": "Africa", "ndjamena": "Africa",
  "mogadishu": "Africa",
  "hargeisa": "Africa",
  "gaborone": "Africa",
  // Middle East
  "basra": "Middle East",
  "erbil international apt": "Middle East", "erbil": "Middle East",
  "salalah": "Middle East",
  // Asia
  "bangalore": "Indian Subcontinent", "delhi": "Indian Subcontinent",
  "mumbai (ex bombay)": "Indian Subcontinent", "mumbai": "Indian Subcontinent",
  "peshawar": "Indian Subcontinent",
  "kabul": "Asia",
  "bishkek (ex frunze)": "Asia", "bishkek": "Asia",
  "atyrau (ex guryev)": "Asia", "atyrau": "Asia",
  "kansai int apt": "Asia", "osaka": "Asia",
  "fukuoka": "Asia",
  "nagoya, aichi": "Asia", "nagoya": "Asia",
  "chongqing": "Asia",
  "shenzhen": "Asia",
  "zhengzhou": "Asia",
  "cebu": "Asia",
  "penang (georgetown)": "Asia", "penang": "Asia",
  // North America / US
  "chico": "US", "cincinnati": "US", "el paso": "US",
  "jacksonville": "US", "kahului": "US", "maui": "US",
  "palm springs": "US", "philadelphia": "US",
  "richmond": "US", "saint louis": "US",
  // Oceania / Indian Ocean islands
  "mahe island apt": "Others", "mahe": "Others",  // Seychelles
  "male": "Indian Subcontinent",  // Maldives
  "malta": "Med",
  "port louis": "Africa",  // Mauritius → Africa
  "sir seewoosagur ramgoolam int apt": "Africa",  // Mauritius
  "ben gurion international apt": "Med",  // Israel
};

function cityToTradelane(name) {
  if (!name) return "";
  return CITY_TRADELANE_MAP[name.toLowerCase().trim()] || "";
}

// Extract iso2 and tradelane from port string "(CCXXX) City"
function portToInfo(portStr) {
  if (!portStr) return { country: "", tradelane: "" };
  const s = String(portStr).trim();
  const m = s.match(/^\(([A-Z]{2,5})\)/);
  if (!m) return { country: "", tradelane: "" };
  const iso2 = m[1].slice(0, 2).toUpperCase();
  const entry = TRADELANE_MAP[iso2];
  return entry ? { country: entry.country, tradelane: entry.tradelane } : { country: "", tradelane: "" };
}

// Legacy compat
function portToCountry(portStr) { return portToInfo(portStr).country; }

// Reverse-lookup: country name (plain text) → tradelane
// Used for ocean/isotank jobs which store Consignee Country / Shipper Country as plain text
const _countryToTradelane = {};
Object.values(TRADELANE_MAP).forEach(function(e) {
  if (e.country) _countryToTradelane[e.country.toLowerCase()] = e.tradelane;
});
function countryNameToTradelane(name) {
  if (!name) return "";
  return _countryToTradelane[String(name).toLowerCase().trim()] || "";
}

async function getTradelaneAggregate(db, force, dateFrom, dateTo, cacheKey) {
  const key = cacheKey || "all";
  const entry = tradelaneCacheMap[key];
  if (!force && entry && (Date.now() - entry.time) < SALES_CACHE_TTL_MS) {
    return { ...entry.data, cached: true };
  }
  const result = await computeTradelaneAggregate(db, dateFrom, dateTo);
  tradelaneCacheMap[key] = { data: result, time: Date.now() };
  return result;
}

async function computeTradelaneAggregate(db, dateFrom, dateTo) {
  const FY_MONTHS_LIST = ["Apr-25","May-25","Jun-25","Jul-25","Aug-25","Sep-25",
    "Oct-25","Nov-25","Dec-25","Jan-26","Feb-26","Mar-26",
    "Apr-26","May-26","Jun-26","Jul-26","Aug-26","Sep-26",
    "Oct-26","Nov-26","Dec-26","Jan-27","Feb-27","Mar-27"];
  let activeMonthSet = null;
  if (dateFrom && dateTo) {
    const fi = FY_MONTHS_LIST.indexOf(dateFrom);
    const ti = FY_MONTHS_LIST.indexOf(dateTo);
    if (fi >= 0 && ti >= 0) activeMonthSet = new Set(FY_MONTHS_LIST.slice(fi, ti + 1));
  }

  // ── Step 1: Build SRR lookup maps: shipmentNo → { country, tradelane } ───────
  // Sea Export: Discharge Country (direct field — use TRADELANE_MAP to get tradelane)
  // Sea Import: Loading Port → portToInfo
  // Air Export: Discharge Port → portToInfo
  // Air Import: Loading Port → portToInfo
  const SRR_CONFIG = [
    { coll: "srr_sea_export",  lob: "Ocean",    dir: "Export", countryField: "Discharge Country", fromPort: false },
    { coll: "srr_sea_import",  lob: "Ocean",    dir: "Import", countryField: "Loading Port",       fromPort: true  },
    { coll: "srr_air_export",  lob: "Air",      dir: "Export", countryField: "Discharge Port",     fromPort: true  },
    { coll: "srr_air_import",  lob: "Air",      dir: "Import", countryField: "Loading Port",       fromPort: true  },
  ];

  // shipmentNo → { country, tradelane, lob, dir }
  const srrMap = {};
  await Promise.all(SRR_CONFIG.map(async (cfg) => {
    try {
      const rows = await db.collection(cfg.coll).find({}, {
        projection: { "Shipment No": 1, [cfg.countryField]: 1 }
      }).toArray();
      for (const r of rows) {
        const sno = String(r["Shipment No"] || "").trim();
        if (!sno) continue;
        const raw = String(r[cfg.countryField] || "").trim();
        let country = "", tradelane = "";
        if (cfg.fromPort) {
          const info = portToInfo(raw);
          country = info.country; tradelane = info.tradelane;
        } else {
          // Direct country name — reverse-lookup tradelane from TRADELANE_MAP by country name
          country = raw;
          const entry = Object.values(TRADELANE_MAP).find(e => e.country.toLowerCase() === raw.toLowerCase());
          tradelane = entry ? entry.tradelane : raw; // fallback to country name if not found
        }
        if (country) srrMap[sno] = { country, tradelane, lob: cfg.lob, dir: cfg.dir };
      }
    } catch (e) { /* collection may not exist yet */ }
  }));

  // ── Step 2: Scan job collections, join with SRR map ──────────────────────────
  const JOB_COLL_MAP = [
    { coll: "jobs_sea_export",     lob: "Ocean", dir: "Export", dateCol: "ETD Loading Port" },
    { coll: "jobs_sea_import",     lob: "Ocean", dir: "Import", dateCol: "ETA Discharge"    },
    { coll: "jobs_air_export",     lob: "Air",   dir: "Export", dateCol: "ETD Loading Port" },
    { coll: "jobs_air_import",     lob: "Air",   dir: "Import", dateCol: "ETA Discharge"    },
    { coll: "jobs_isotank_export", lob: "ISO Tank", dir: "Export", dateCol: "ETD Loading Port" },
    { coll: "jobs_isotank_import", lob: "ISO Tank", dir: "Import", dateCol: "ETA Discharge"    },
  ];

  const projection = {
    "Shipment No": 1, "Billed Revenue (C)": 1,
    "Actual Profit (J=C-G)": 1, "Provisional Profit (I=A-E)": 1,
    "Financial Lock": 1, "Operation Lock": 1,
    "Sales Person": 1, "Chargeable Weight": 1, "Chargeable Weight Unit": 1,
    "Container TEU": 1, "Volume": 1, "Volume Unit": 1, "Cargo Type": 1,
    "ETD Loading Port": 1, "ETA Discharge": 1, "Job Date": 1,
    "Consignee Country": 1, "Shipper Country": 1, "Trade Lane": 1,
    "Destination Country": 1, "Origin Port Country": 1,
    "Discharge Port": 1, "Loading Port": 1,
  };

  // countryMap: country → { shipments, revenue, gp, tons, teu, salesReps, lobs }
  const countryMap = {};
  // countryMapByLob: lob → country → same
  const countryMapByLob = { "Air": {}, "Ocean": {}, "ISO Tank": {} };

  await Promise.all(JOB_COLL_MAP.map(async (cfg) => {
    const cls = {
      kind: cfg.lob === "Air" ? "AIR" : cfg.lob === "ISO Tank" ? "ISOTANK" : "SEA",
      direction: cfg.dir === "Import" ? "IMPORT" : "EXPORT",
    };
    const isAir = cfg.lob === "Air";
    const jobs = await db.collection(cfg.coll).find({}, { projection }).toArray();

    for (const job of jobs) {
      // Date filter
      if (activeMonthSet) {
        const rawDate = job[cfg.dateCol] || job["Job Date"];
        if (!rawDate) continue;
        const dObj = parseSheetDate(rawDate);
        if (!dObj) continue;
        const ml = MONTH_NAMES[dObj.getMonth()] + "-" + String(dObj.getFullYear()).slice(2);
        if (!activeMonthSet.has(ml)) continue;
      }

      const sno = String(job["Shipment No"] || "").trim();
      const srrEntry = srrMap[sno];

      let tradelane = "", country = "";
      if (srrEntry) {
        // SRR match — most accurate source
        tradelane = srrEntry.tradelane || srrEntry.country;
        country   = srrEntry.country;
      } else if (cfg.lob === "Air") {
        // Air: no country fields on job row — skip if not in SRR
        continue;
      } else {
        // Ocean / ISO Tank: use country fields directly on the job row
        // Export: foreign country = Consignee Country (destination)
        // Import: foreign country = Shipper Country (origin)
        // Export: Consignee Country or Destination Country (foreign destination)
        // Import: Shipper Country or Origin Port Country (foreign origin)
        const rawCountry = cfg.dir === "Export"
          ? (String(job["Consignee Country"] || job["Destination Country"] || "").trim())
          : (String(job["Shipper Country"]   || job["Origin Port Country"] || "").trim());

        if (!rawCountry || rawCountry.toLowerCase() === "india") {
          // Try Trade Lane field as last resort
          const tl = String(job["Trade Lane"] || "").trim();
          if (!tl) continue;
          tradelane = tl;
          country   = tl;
        } else {
          country   = rawCountry;
          tradelane = countryNameToTradelane(rawCountry) || rawCountry;
        }
      }
      if (!tradelane) continue;

      const revenue = parseFloat(job["Billed Revenue (C)"] || 0) || 0;
      const { gp } = pickGP(job, cls);

      let tons = 0;
      if (isAir) {
        const rawW = parseFloat(job["Chargeable Weight"] || 0) || 0;
        const wUnit = String(job["Chargeable Weight Unit"] || "").toLowerCase().trim();
        if (wUnit === "ton" || wUnit === "tons" || wUnit === "mt") tons = rawW;
        else if (wUnit === "lb" || wUnit === "lbs") tons = rawW * 0.000453592;
        else tons = rawW / 1000;
      }
      const teu = !isAir ? (parseFloat(job["Container TEU"] || 0) || 0) : 0;
      // FCL TEU vs Tank TEU vs LCL
      const cargoType = String(job["Cargo Type"] || "").toUpperCase().trim();
      const isIsoTank = cfg.lob === "ISO Tank";
      const fclTeu  = (!isAir && !isIsoTank && (cargoType === "FCL" || cargoType === "LIQUID (CONT)")) ? teu : 0;
      const tankTeu = (!isAir && isIsoTank) ? teu : 0;
      const lclVol  = (!isAir && cargoType === "LCL") ? (parseFloat(job["Volume"] || 0) || 0) : 0;

      const rawSP = String(job["Sales Person"] || "").trim();
      const dispSP = rawSP ? rawSP.split("|")[0].trim() : "";

      const lobLabel = cfg.lob === "Air"
        ? (cfg.dir === "Import" ? "Air Imp" : "Air Exp")
        : cfg.lob === "ISO Tank"
          ? (cfg.dir === "Import" ? "ISO Imp" : "ISO Exp")
          : (cfg.dir === "Import" ? "Sea Imp" : "Sea Exp");

      // Derive month label for this job
      const rawDateM = job[cfg.dateCol] || job["Job Date"];
      let monthLabel = "";
      if (rawDateM) {
        const dM = parseSheetDate(rawDateM);
        if (dM) monthLabel = MONTH_NAMES[dM.getMonth()] + "-" + String(dM.getFullYear()).slice(2);
      }

      function addTo(map, key) {
        if (!map[key]) map[key] = { shipments:0, revenue:0, gp:0, tons:0, teu:0, fclTeu:0, tankTeu:0, lcl:0, salesReps:new Set(), lobs:new Set(), countries:new Set(), shipmentNos:new Set(), monthData:{}, weekData:{} };
        const isNewSno = !map[key].shipmentNos.has(sno);
        if (isNewSno) map[key].shipments++;
        map[key].shipmentNos.add(sno);
        map[key].revenue += revenue;
        map[key].gp += gp;
        map[key].tons += tons;
        map[key].teu += teu;
        map[key].fclTeu  += fclTeu;
        map[key].tankTeu += tankTeu;
        map[key].lcl     += lclVol;
        if (dispSP) map[key].salesReps.add(dispSP);
        if (sno) map[key].shipmentNos.add(sno);
        map[key].lobs.add(lobLabel);
        if (country) map[key].countries.add(country);
        if (monthLabel) {
          if (!map[key].monthData[monthLabel]) map[key].monthData[monthLabel] = { shipments:0, revenue:0, gp:0, tons:0, teu:0, fclTeu:0, tankTeu:0, lcl:0, _snos:new Set() };
          if (!map[key].monthData[monthLabel]._snos.has(sno)) { map[key].monthData[monthLabel].shipments++; map[key].monthData[monthLabel]._snos.add(sno); }
          map[key].monthData[monthLabel].revenue += revenue;
          map[key].monthData[monthLabel].gp += gp;
          map[key].monthData[monthLabel].tons += tons;
          map[key].monthData[monthLabel].teu  += teu;
          map[key].monthData[monthLabel].fclTeu  += fclTeu;
          map[key].monthData[monthLabel].tankTeu += tankTeu;
          map[key].monthData[monthLabel].lcl     += lclVol;
        }
        const _wkObj = rawDateM ? parseSheetDate(rawDateM) : null;
        const _wkKey = _wkObj ? isoWeekInfo(_wkObj).key : '';
        if (_wkKey) {
          if (!map[key].weekData[_wkKey]) map[key].weekData[_wkKey] = { shipments:0, revenue:0, gp:0, tons:0, teu:0, _snos:new Set() };
          if (!map[key].weekData[_wkKey]._snos.has(sno)) { map[key].weekData[_wkKey].shipments++; map[key].weekData[_wkKey]._snos.add(sno); }
          map[key].weekData[_wkKey].revenue += revenue;
          map[key].weekData[_wkKey].gp += gp;
          map[key].weekData[_wkKey].tons += tons;
          map[key].weekData[_wkKey].teu  += teu;
        }
      }
      addTo(countryMap, tradelane);
      if (countryMapByLob[cfg.lob]) addTo(countryMapByLob[cfg.lob], tradelane);
    }
  }));

  function buildStats(cmap) {
    const rows = Object.entries(cmap).map(([name, d]) => ({
      name,
      shipments: d.shipments,
      revenue:   Math.round(d.revenue),
      gp:        Math.round(d.gp),
      tons:      Math.round(d.tons * 100) / 100,
      teu:       Math.round(d.teu * 100) / 100,
      fclTeu:    Math.round(d.fclTeu * 100) / 100,
      tankTeu:   Math.round(d.tankTeu * 100) / 100,
      lcl:       Math.round(d.lcl * 100) / 100,
      gpPct:     d.revenue > 0 ? Math.round((d.gp / d.revenue) * 1000) / 10 : 0,
      salesReps:   [...d.salesReps],
      lobs:        [...d.lobs].sort(),
      countries:   [...d.countries].sort(),
      shipmentNos: [...d.shipmentNos],
      weekData:    Object.fromEntries(Object.entries(d.weekData||{}).map(([wk,wd])=>[wk,{shipments:wd.shipments,revenue:Math.round(wd.revenue),gp:Math.round(wd.gp),tons:Math.round(wd.tons*100)/100,teu:Math.round(wd.teu*100)/100}])),
      monthData: Object.fromEntries(
        Object.entries(d.monthData||{}).map(([m, md]) => [m, {
          shipments: md.shipments,
          revenue:   Math.round(md.revenue),
          gp:        Math.round(md.gp),
          gpPct:     md.revenue > 0 ? Math.round((md.gp / md.revenue) * 1000) / 10 : 0,
          tons:      Math.round((md.tons||0) * 100) / 100,
          teu:       Math.round((md.teu||0) * 100) / 100,
          fclTeu:    Math.round((md.fclTeu||0) * 100) / 100,
          tankTeu:   Math.round((md.tankTeu||0) * 100) / 100,
          lcl:       Math.round((md.lcl||0) * 100) / 100,
        }])
      ),
    }));
    function top10(arr, key) { return [...arr].sort((a,b)=>b[key]-a[key]).slice(0,10); }
    return {
      topByShipments:  top10(rows, "shipments"),
      topByRevenue:    top10(rows, "revenue"),
      topByGP:         top10(rows, "gp"),
      topByTons:       top10(rows.filter(r=>r.tons>0), "tons"),
      topByTEU:        top10(rows.filter(r=>r.teu>0), "teu"),
      topByGPPct:      top10(rows.filter(r=>r.shipments>=2), "gpPct"),
      totalCountries:  rows.length,
      allCountries:    [...rows].sort((a,b)=>b.gp-a.gp),
    };
  }

  return {
    success: true,
    lobs: {
      "Air":      buildStats(countryMapByLob["Air"]),
      "Ocean":    buildStats(countryMapByLob["Ocean"]),
      "ISO Tank": buildStats(countryMapByLob["ISO Tank"]),
    },
    ...buildStats(countryMap),
    pushedAt: new Date().toISOString(),
  };
}

async function getAgentAggregate(db, force, dateFrom, dateTo, cacheKey) {
  const key = cacheKey || 'all';
  const entry = agentCacheMap[key];
  if (!force && entry && (Date.now() - entry.time) < SALES_CACHE_TTL_MS) {
    return { ...entry.data, cached: true };
  }
  const result = await computeAgentAggregate(db, dateFrom, dateTo);
  agentCacheMap[key] = { data: result, time: Date.now() };
  return result;
}

async function computeAgentAggregate(db, dateFrom, dateTo) {
  const FY_MONTHS_LIST = ["Apr-25","May-25","Jun-25","Jul-25","Aug-25","Sep-25",
    "Oct-25","Nov-25","Dec-25","Jan-26","Feb-26","Mar-26",
    "Apr-26","May-26","Jun-26","Jul-26","Aug-26","Sep-26",
    "Oct-26","Nov-26","Dec-26","Jan-27","Feb-27","Mar-27"];
  let activeMonthSet = null;
  if (dateFrom && dateTo) {
    const fi = FY_MONTHS_LIST.indexOf(dateFrom);
    const ti = FY_MONTHS_LIST.indexOf(dateTo);
    if (fi >= 0 && ti >= 0) activeMonthSet = new Set(FY_MONTHS_LIST.slice(fi, ti + 1));
  }

  const LOB_GROUPS = {
    "Air":      ["jobs_air_export",     "jobs_air_import"],
    "Ocean":    ["jobs_sea_export",     "jobs_sea_import"],
    "ISO Tank": ["jobs_isotank_export", "jobs_isotank_import"],
  };
  const ALL_COLLS = Object.values(LOB_GROUPS).flat();

  const agentMapByLob = { "Air": {}, "Ocean": {}, "ISO Tank": {} };
  const agentMapAll   = {};
  const agentSalesReps  = {}; // agent → Set of sales rep display names
  const agentLobLabels  = {}; // agent → Set of lob sub-labels

  const projection = {
    "Destination Agent": 1, "Origin Agent": 1,
    "Billed Revenue (C)": 1,
    "Actual Profit (J=C-G)": 1, "Provisional Profit (I=A-E)": 1,
    "Financial Lock": 1, "Operation Lock": 1,
    "Sales Person": 1,
    "Chargeable Weight": 1, "Chargeable Weight Unit": 1,
    "Container TEU": 1,
    "ETD Loading Port": 1, "ETA Discharge": 1, "Job Date": 1,
  };

  await Promise.all(ALL_COLLS.map(async (collName) => {
    const lob = collName.includes("air") ? "Air"
              : collName.includes("isotank") ? "ISO Tank"
              : "Ocean";
    const isAir    = lob === "Air";
    const isExport = collName.includes("export");
    const isImport = collName.includes("import");
    const cls = {
      kind: isAir ? "AIR" : collName.includes("isotank") ? "ISOTANK" : "SEA",
      direction: isImport ? "IMPORT" : "EXPORT"
    };
    const dateCol = isExport ? "ETD Loading Port" : isImport ? "ETA Discharge" : "Job Date";
    const lobLabel = lob === "Air"
      ? (isImport ? "Air Imp" : "Air Exp")
      : lob === "ISO Tank"
        ? (isImport ? "ISO Imp" : "ISO Exp")
        : (isImport ? "Sea Imp" : "Sea Exp");

    const jobs = await db.collection(collName).find({}, { projection }).toArray();

    for (const job of jobs) {
      // Date filter
      if (activeMonthSet) {
        const rawDate = job[dateCol]; // ETD/ETA only — no Job Date fallback (matches getDrillRows)
        if (!rawDate) continue;
        const dObj = parseSheetDate(rawDate);
        if (!dObj) continue;
        const ml = MONTH_NAMES[dObj.getMonth()] + "-" + String(dObj.getFullYear()).slice(2);
        if (!activeMonthSet.has(ml)) continue;
      }

      // Agent: Export → Destination Agent, Import → Origin Agent
      const agentRaw = isExport
        ? String(job["Destination Agent"] || "").trim()
        : String(job["Origin Agent"] || "").trim();
      if (!agentRaw) continue;

      const revenue = parseFloat(job["Billed Revenue (C)"] || 0) || 0;
      const { gp } = pickGP(job, cls);

      let tons = 0;
      if (isAir) {
        const rawW = parseFloat(job["Chargeable Weight"] || 0) || 0;
        const wUnit = String(job["Chargeable Weight Unit"] || "").toLowerCase().trim();
        if (wUnit === "ton" || wUnit === "tons" || wUnit === "mt") tons = rawW;
        else if (wUnit === "lb" || wUnit === "lbs") tons = rawW * 0.000453592;
        else tons = rawW / 1000;
      }
      let teu = 0;
      if (!isAir) teu = parseFloat(job["Container TEU"] || 0) || 0;

      function addTo(map, key) {
        if (!map[key]) map[key] = { shipments:0, revenue:0, gp:0, tons:0, teu:0 };
        map[key].shipments++; map[key].revenue += revenue; map[key].gp += gp;
        map[key].tons += tons; map[key].teu += teu;
      }
      addTo(agentMapByLob[lob], agentRaw);
      addTo(agentMapAll, agentRaw);

      // Sales rep tracking
      const rawSP = String(job["Sales Person"] || "").trim();
      const dispSP = rawSP ? rawSP.split("|")[0].trim() : "";
      if (dispSP) {
        if (!agentSalesReps[agentRaw]) agentSalesReps[agentRaw] = new Set();
        agentSalesReps[agentRaw].add(dispSP);
      }
      // LOB label tracking
      if (!agentLobLabels[agentRaw]) agentLobLabels[agentRaw] = new Set();
      agentLobLabels[agentRaw].add(lobLabel);
    }
  }));

  function buildStats(agentMap) {
    const agents = Object.entries(agentMap).map(([name, d]) => ({
      name,
      shipments: d.shipments,
      revenue:   Math.round(d.revenue),
      gp:        Math.round(d.gp),
      tons:      Math.round(d.tons * 100) / 100,
      teu:       Math.round(d.teu * 100) / 100,
      gpPct:     d.revenue > 0 ? Math.round((d.gp / d.revenue) * 1000) / 10 : 0,
      salesReps: agentSalesReps[name] ? [...agentSalesReps[name]] : [],
      lobs:      agentLobLabels[name] ? [...agentLobLabels[name]].sort() : [],
    }));
    function top10(arr, key) { return [...arr].sort((a,b)=>b[key]-a[key]).slice(0,10); }
    return {
      topByShipments: top10(agents, "shipments"),
      topByRevenue:   top10(agents, "revenue"),
      topByGP:        top10(agents, "gp"),
      topByTons:      top10(agents.filter(c=>c.tons>0), "tons"),
      topByTEU:       top10(agents.filter(c=>c.teu>0), "teu"),
      topByGPPct:     top10(agents.filter(c=>c.shipments>=2), "gpPct"),
      totalAgents:    agents.length,
      allAgents:      [...agents].sort((a,b)=>b.gp-a.gp),
    };
  }

  return {
    success: true,
    lobs: {
      "Air":      buildStats(agentMapByLob["Air"]),
      "Ocean":    buildStats(agentMapByLob["Ocean"]),
      "ISO Tank": buildStats(agentMapByLob["ISO Tank"]),
    },
    ...buildStats(agentMapAll),
    pushedAt: new Date().toISOString(),
  };
}

// In-memory cache for usage analytics
let usageCache = null;
let usageCacheTime = 0;

async function getUsageAnalytics(db, force) {
  if (!force && usageCache && (Date.now() - usageCacheTime) < SALES_CACHE_TTL_MS) {
    return { ...usageCache, cached: true };
  }
  const result = await computeUsageAnalytics(db);
  usageCache = result;
  usageCacheTime = Date.now();
  return result;
}

async function computeUsageAnalytics(db) {
  const users = await db.collection("users").find({}).toArray();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Count logins from login_events for accuracy (users.loginCount can be stale)
  const loginEvents = await db.collection("login_events").find({}).toArray();
  const loginCountByEmail = {};
  loginEvents.forEach(function(e){
    var em = (e.email||'').toLowerCase().trim();
    loginCountByEmail[em] = (loginCountByEmail[em]||0) + 1;
  });

  const userRows = users.map((u, i) => ({
    index:       i + 1,
    name:        u.name || "",
    email:       u.email || "",
    role:        u.role || "user",
    totalLogins: loginCountByEmail[(u.email||'').toLowerCase().trim()] || u.loginCount || 0,
    lastLogin:   u.lastLogin ? u.lastLogin.toISOString() : null,
    isActive:    u.isActive !== false,
  }));

  userRows.sort((a, b) => b.totalLogins - a.totalLogins);
  userRows.forEach((u, i) => { u.index = i + 1; });

  const totalUsers   = userRows.length;
  const activeUsers  = userRows.filter(u => u.isActive).length;
  const loggedIn7Day = userRows.filter(u => u.lastLogin && new Date(u.lastLogin) >= sevenDaysAgo).length;

  return {
    success: true,
    totalUsers,
    activeUsers,
    loggedIn7Day,
    users: userRows,
    pushedAt: new Date().toISOString(),
  };
}

let financeCache = null;
let financeCacheTime = 0;

let opCache = null;
let opCacheTime = 0;

// In-flight promise guard — prevents two parallel computeBothPendency calls
let _pendencyBuildPromise = null;

async function getOpPendency(db, force) {
  if (!force && opCache && (Date.now() - opCacheTime) < SALES_CACHE_TTL_MS) {
    return { ...opCache, cached: true };
  }
  await _ensurePendencyCache(db, force);
  return { ...opCache, cached: false };
}

async function getFinancePendency(db, force) {
  if (!force && financeCache && (Date.now() - financeCacheTime) < SALES_CACHE_TTL_MS) {
    return { ...financeCache, cached: true };
  }
  await _ensurePendencyCache(db, force);
  return { ...financeCache, cached: false };
}

// Ensures both caches built in ONE single DB pass.
// If a build is already in flight, waits for it instead of starting a second one.
async function _ensurePendencyCache(db, force) {
  if (!force && _pendencyBuildPromise) return _pendencyBuildPromise;
  _pendencyBuildPromise = computeBothPendency(db).then(({ op, finance }) => {
    opCache = op;           opCacheTime = Date.now();
    financeCache = finance; financeCacheTime = Date.now();
    _pendencyBuildPromise = null;
  }).catch(e => { _pendencyBuildPromise = null; throw e; });
  return _pendencyBuildPromise;
}

// Single-pass: loads mapping + all job collections ONCE, builds OL and FL simultaneously
async function computeBothPendency(db) {
  const mappingRows = await db.collection("mapping_sales_targets").find(
    {}, { projection: { "Sales Rep Name": 1, "Display Name": 1, "Zone": 1, "_fy": 1 } }
  ).toArray();

  // Build two lookups from mapping:
  // 1. normalized rep name → zone
  // 2. INZ code (e.g. "INZ05") → zone name (extracted from pipe-separated Sales Rep Name fields)
  const repZoneMap = {};    // normalized name → zone
  const repDisplayMap = {}; // normalized name → display name
  const inzCodeZoneMap = {}; // "INZ05" → zone name

  for (const row of mappingRows) {
    const rawName = String(row["Sales Rep Name"] || "").trim();
    const display = String(row["Display Name"] || rawName || "").trim();
    const zone    = String(row["Zone"] || "Unassigned").trim();
    const isFY26  = row._fy !== "FY27";

    // Extract INZ code from pipe-separated Sales Rep Name: "Sachin | INZ16" → "INZ16"
    const parts = rawName.split("|").map(s => s.trim());
    for (const part of parts) {
      if (/^IN[A-Z]?\d+$/i.test(part)) {
        const code = part.toUpperCase();
        if (!inzCodeZoneMap[code] || isFY26) inzCodeZoneMap[code] = zone;
      }
    }

    // Name-based lookup (both raw and display)
    const normRaw = normalizeName(rawName);
    const normDis = normalizeName(display);
    for (const key of [normRaw, normDis]) {
      if (!key) continue;
      if (!repZoneMap[key] || isFY26) {
        repZoneMap[key]    = zone;
        repDisplayMap[key] = display;
      }
    }
  }

  // Direct lean query across all collections in parallel
  // Filter to FY date range at DB level — avoids pulling irrelevant rows
  // Single DB pass — track OL and FL simultaneously in same loop
  // No DB-level date filter — DD/MM/YYYY format breaks string comparison.
  // FY_MONTHS check in parseSheetDate handles in-memory filtering.
  const ALL_JOB_COLLS = Object.values(COLLECTIONS);
  const allDrillJobRows = []; // all job rows for client-side drill filtering
  // Two independent maps — one per lock type — built in the same loop
  const olMap = {}; // OL: norm → { zone, displayName, monthData: { month → { pending, done } }, jobOwners }
  const flMap = {}; // FL: same structure
  const seenMonths = new Set();

  await Promise.all(ALL_JOB_COLLS.map(async (collName) => {
    const isExport = collName.includes("export");
    const isImport = collName.includes("import");
    const dateField = isExport ? "ETD Loading Port" : isImport ? "ETA Discharge" : "Job Date";

    const jobs = await db.collection(collName).find(
      {},
      { projection: { "Sales Person": 1, "Job Owner": 1, "Financial Lock": 1, "Operation Lock": 1,
        [dateField]: 1, "Job Date": 1, "Shipment No": 1, "Customer": 1, "Location": 1,
        "Carrier": 1, "Carrier Name": 1, "ETD Loading Port": 1, "ETA Discharge": 1, "LOB": 1 } }
    ).toArray();

    for (const job of jobs) {
      const rawName = String(job["Sales Person"] || "").trim();
      if (!rawName) continue;
      const norm = normalizeName(rawName);

      const rawDate = job[dateField] || job["Job Date"];
      if (!rawDate) continue;
      const d = parseSheetDate(rawDate);
      if (!d) continue;
      const monthLabel = MONTH_NAMES[d.getMonth()] + "-" + String(d.getFullYear()).slice(2);
      if (!FY_MONTHS.includes(monthLabel)) continue;

      const nameParts = rawName.split("|").map(s => s.trim());
      const cleanName = nameParts[0] || rawName;

      let zone = repZoneMap[norm] || "";
      let displayName = repDisplayMap[norm] || cleanName;
      if (!zone) {
        for (const part of nameParts.slice(1)) {
          const trimmed = part.toUpperCase();
          if (inzCodeZoneMap[trimmed]) { zone = inzCodeZoneMap[trimmed]; break; }
          if (/^IN[A-Z]?\d+$/.test(trimmed)) { zone = zone || trimmed; }
        }
      }
      if (!zone) zone = "Unassigned";

      const jobOwner = String(job["Job Owner"] || "").trim().split("|")[0].trim() || "";
      const olDone = job["Operation Lock"] && String(job["Operation Lock"]).trim() !== "";
      const flDone = job["Financial Lock"]  && String(job["Financial Lock"]).trim()  !== "";
      const cls = classifyRow(job, collName);

      // Store compact drill row — shared across OL and FL, lock status derived client-side
      const displayNorm = normalizeName(displayName);
      allDrillJobRows.push({
        _norm: norm, _displayNorm: displayNorm, _repName: displayName, _zone: zone, _month: monthLabel,
        _wk: isoWeekInfo(d).key,
        olDone, flDone,
        shipmentNo:  job["Shipment No"]     || "—",
        jobDate:     job["Job Date"]        || "",
        lob:         cls.kind + (cls.direction ? " " + cls.direction : ""),
        customer:    String(job["Customer"] || "").trim() || "—",
        salesPerson: cleanName,
        jobOwner:    jobOwner || "—",
        carrier:     job["Carrier"] || job["Carrier Name"] || "—",
        location:    job["Location"]        || "—",
        etdLoading:  job["ETD Loading Port"]|| "",
        etaDischarge:job["ETA Discharge"]   || "",
        month:       monthLabel,
      });

      // Helper: ensure rep entry exists in a map
      function ensureRep(map) {
        if (!map[norm]) map[norm] = { zone, displayName, monthData: {}, jobOwners: {} };
        if (!map[norm].monthData[monthLabel]) map[norm].monthData[monthLabel] = { pending: 0, done: 0 };
        if (jobOwner && jobOwner.toLowerCase() !== displayName.toLowerCase()) {
          if (!map[norm].jobOwners[jobOwner]) map[norm].jobOwners[jobOwner] = {};
          if (!map[norm].jobOwners[jobOwner][monthLabel]) map[norm].jobOwners[jobOwner][monthLabel] = { pending: 0, done: 0 };
        }
      }

      const lobKey = cls.kind + (cls.direction ? " " + cls.direction : "");

      ensureRep(olMap);
      // Track per-LOB counts for client-side LOB filtering
      if (!olMap[norm].lobMonthData) olMap[norm].lobMonthData = {};
      if (!olMap[norm].lobMonthData[lobKey]) olMap[norm].lobMonthData[lobKey] = {};
      if (!olMap[norm].lobMonthData[lobKey][monthLabel]) olMap[norm].lobMonthData[lobKey][monthLabel] = { pending:0, done:0 };
      if (olDone) { olMap[norm].monthData[monthLabel].done++; olMap[norm].lobMonthData[lobKey][monthLabel].done++; if (jobOwner && jobOwner.toLowerCase() !== displayName.toLowerCase() && olMap[norm].jobOwners[jobOwner]) olMap[norm].jobOwners[jobOwner][monthLabel].done++; }
      else        { olMap[norm].monthData[monthLabel].pending++; olMap[norm].lobMonthData[lobKey][monthLabel].pending++; if (jobOwner && jobOwner.toLowerCase() !== displayName.toLowerCase() && olMap[norm].jobOwners[jobOwner]) olMap[norm].jobOwners[jobOwner][monthLabel].pending++; }

      ensureRep(flMap);
      if (!flMap[norm].lobMonthData) flMap[norm].lobMonthData = {};
      if (!flMap[norm].lobMonthData[lobKey]) flMap[norm].lobMonthData[lobKey] = {};
      if (!flMap[norm].lobMonthData[lobKey][monthLabel]) flMap[norm].lobMonthData[lobKey][monthLabel] = { pending:0, done:0 };
      if (flDone) { flMap[norm].monthData[monthLabel].done++; flMap[norm].lobMonthData[lobKey][monthLabel].done++; if (jobOwner && jobOwner.toLowerCase() !== displayName.toLowerCase() && flMap[norm].jobOwners[jobOwner]) flMap[norm].jobOwners[jobOwner][monthLabel].done++; }
      else        { flMap[norm].monthData[monthLabel].pending++; flMap[norm].lobMonthData[lobKey][monthLabel].pending++; if (jobOwner && jobOwner.toLowerCase() !== displayName.toLowerCase() && flMap[norm].jobOwners[jobOwner]) flMap[norm].jobOwners[jobOwner][monthLabel].pending++; }

      seenMonths.add(monthLabel);
    }
  }));

  const monthsInData = FY_MONTHS.filter(m => seenMonths.has(m));

  function buildResult(repMonthMap) {
    const reps = Object.values(repMonthMap).map((rep) => {
      let totalPending = 0, totalDone = 0;
      for (const m of monthsInData) {
        totalPending += (rep.monthData[m]?.pending || 0);
        totalDone    += (rep.monthData[m]?.done    || 0);
      }
      const jobOwners = Object.entries(rep.jobOwners || {}).map(([ownerName, ownerMonthData]) => {
        let op = 0, od = 0;
        for (const m of monthsInData) { op += ownerMonthData[m]?.pending||0; od += ownerMonthData[m]?.done||0; }
        return { name: ownerName, monthData: ownerMonthData, totalPending: op, totalDone: od, total: op+od };
      }).filter(o => o.total > 0).sort((a,b) => b.total - a.total);
      return { name: rep.displayName, zone: rep.zone, monthData: rep.monthData, lobMonthData: rep.lobMonthData||{}, totalPending, totalDone, total: totalPending + totalDone, jobOwners };
    }).sort((a, b) => b.total - a.total);

    const zoneMap = {};
    for (const rep of reps) {
      if (!zoneMap[rep.zone]) zoneMap[rep.zone] = { totalPending: 0, totalDone: 0, total: 0 };
      zoneMap[rep.zone].totalPending += rep.totalPending;
      zoneMap[rep.zone].totalDone    += rep.totalDone;
      zoneMap[rep.zone].total        += rep.total;
    }
    const zones = Object.entries(zoneMap).sort((a, b) => b[1].total - a[1].total).map(([name]) => name);
    return { success: true, months: monthsInData, reps, zones, pushedAt: new Date().toISOString() };
  }

  const opResult  = buildResult(olMap);
  const finResult = buildResult(flMap);
  // Attach drill rows to op only — client shares them for both OL and FL filtering
  opResult.allDrillJobRows = allDrillJobRows;
  return { op: opResult, finance: finResult };
}


// Helper: get correct mapping collection for Ocean dashboard
async function _getOceanMappingRows(db, projection) {
  const proj = projection || {};
  let rows = await db.collection("ocean_mapping_sales_targets").find({}, Object.keys(proj).length ? {projection:proj} : {}).toArray();
  if (!rows || rows.length === 0) {
    rows = await db.collection("mapping_sales_targets").find({}, Object.keys(proj).length ? {projection:proj} : {}).toArray();
  }
  return rows;
}
async function _getOceanZoneTargetRows(db) {
  let rows = await db.collection("ocean_mapping_zone_targets").find({}).toArray();
  if (!rows || rows.length === 0) {
    rows = await db.collection("mapping_zone_targets").find({}).toArray();
  }
  return rows;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Bust stale in-memory caches immediately if this deployment changed logic
  if (salesCache?._deployTs !== DEPLOY_TS) { salesCache = null; salesCacheTime = 0; }
  if (drillRowsCache?.deployTs !== DEPLOY_TS) { drillRowsCache = null; drillRowsCacheTime = 0; }
  // Bust tradelane cache on new deployment
  if (!global._tradelaneCacheTs || global._tradelaneCacheTs !== DEPLOY_TS) {
    Object.keys(tradelaneCacheMap).forEach(k => delete tradelaneCacheMap[k]);
    global._tradelaneCacheTs = DEPLOY_TS;
  }

  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query?.action || req.body?.action;
  if (!action) return res.status(400).json({ error: "action required: jobs | mapping | users | sales" });

  // Lightweight ping — warms up the serverless function + DB connection.
  // Also proactively refreshes the sales cache in the background so users
  // never hit a cold, slow full-aggregation on their first page load.
  if (action === "ping") {
    const db = await getDB();
    const now2 = Date.now();

    const needsSales   = !salesCache   || (now2 - salesCacheTime)   > (SALES_CACHE_TTL_MS - 20 * 60 * 1000);
    const needsFinance = !financeCache || (now2 - financeCacheTime) > (SALES_CACHE_TTL_MS - 20 * 60 * 1000);
    const needsOp      = !opCache      || (now2 - opCacheTime)      > (SALES_CACHE_TTL_MS - 20 * 60 * 1000);
    const needsDrill   = !drillRowsCache || (now2 - drillRowsCacheTime) > (SALES_CACHE_TTL_MS - 20 * 60 * 1000);

    // Check if tradelane cache needs refresh
    const needsTradelane = !tradelaneCacheMap['all'] ||
      (Date.now() - (tradelaneCacheMap['all'].time||0)) > (SALES_CACHE_TTL_MS - 20 * 60 * 1000);

    // Build all caches in parallel — include tradelane (no date filter = all data)
    const [salesResult, financeResult, opResult, tradelaneResult] = await Promise.all([
      needsSales     ? getSalesAggregate(db, false).catch(() => null)             : Promise.resolve(salesCache),
      needsFinance   ? getFinancePendency(db, false).catch(() => null)            : Promise.resolve(financeCache),
      needsOp        ? getOpPendency(db, false).catch(() => null)                 : Promise.resolve(opCache),
      needsTradelane ? getTradelaneAggregate(db, false, '', '', 'all').catch(() => null) : Promise.resolve(tradelaneCacheMap['all']?.data || null),
    ]);

    // Build drill rows cache if needed
    if (needsDrill) {
      await getDrillRows(db, "Grand Total", "Shipments", "FY Total").catch(() => null);
    }

    // Strip weekData from sales, keep Air lobData for default LOB filter
    let salesStripped = null;
    if (salesResult && salesResult.repsRaw) {
      salesStripped = { ...salesResult, repsRaw: salesResult.repsRaw.map(r => {
        const c = { ...r }; delete c.weekData;
        if (c.lobData) {
          const airOnly = {};
          if (c.lobData['AIR EXPORT']) airOnly['AIR EXPORT'] = c.lobData['AIR EXPORT'];
          if (c.lobData['AIR IMPORT']) airOnly['AIR IMPORT'] = c.lobData['AIR IMPORT'];
          c.lobData = airOnly;
        }
        return c;
      })};
      // Bundle allDrillRows from drillRowsCache so client never needs a separate drill fetch
      // Ocean: do NOT bundle allDrillRows in ping — too large, fetched on demand instead
    }

    // Include lastUpdated so client knows if data changed since last cache
    let lastUpdated = null;
    try {
      const meta = await db.collection("_meta").findOne({ _id: "push_meta" });
      if (meta && meta.lastUpdated) lastUpdated = meta.lastUpdated;
    } catch(e) {}

    return res.status(200).json({
      ok: true, ts: now2,
      lastUpdated,
      sales:      salesStripped  || null,
      finance:    financeResult  || null,
      op:         opResult       || null,
      tradelane:  tradelaneResult || null,
    });
  }

  // "sales" is a read action — allow GET. Everything else requires POST.
  const READ_ONLY_ACTIONS = new Set(["sales", "meta", "debug", "srrProbe", "customers", "agents", "tradelane", "usage", "org", "lobCheck", "drill", "ping", "finance", "financeDebug", "op", "pendencyDrill", "tradelaneDebug"]);
  if (!READ_ONLY_ACTIONS.has(action) && req.method !== "POST") {
    return res.status(405).json({ error: "Use POST for this action." });
  }

  try {
    const db = await getDB();

    if (action === "salesDebug") {
      // Check what's actually in Apr-26 for air export
      const apr26Jobs = await db.collection("jobs_air_export").find(
        { _fy: "FY27" },
        { projection: { "Sales Person":1, "ETD Loading Port":1, "Job Date":1, "LOB":1, "Provisional Profit (I=A-E)":1, "Actual Profit (J=C-G)":1 } }
      ).limit(5).toArray();
      const apr26Sea = await db.collection("jobs_sea_export").find(
        { _fy: "FY27" },
        { projection: { "Sales Person":1, "ETD Loading Port":1, "Job Date":1, "LOB":1, "Provisional Profit (I=A-E)":1 } }
      ).limit(5).toArray();
      const counts = {};
      for (const cn of JOB_COLLECTIONS) {
        counts[cn] = {
          total: await db.collection(cn).countDocuments({}),
          fy26:  await db.collection(cn).countDocuments({ _fy: "FY26" }),
          fy27:  await db.collection(cn).countDocuments({ _fy: "FY27" }),
        };
      }
      return res.status(200).json({ counts, apr26AirSample: apr26Jobs, apr26SeaSample: apr26Sea });
    }

    if (action === "srrProbe") {
      const cols = await db.listCollections().toArray();
      const allNames = cols.map(c => c.name);
      const srrNames = allNames.filter(n => n.toLowerCase().includes('srr'));
      const result = { allCollections: allNames, srrCollections: srrNames, samples: {}, allPortCodes: {} };
      for (const name of srrNames) {
        const rows = await db.collection(name).find({}).toArray();
        result.samples[name] = {
          count: rows.length,
          fields: rows[0] ? Object.keys(rows[0]).filter(k => k !== '_id') : [],
          row0: rows[0] ? Object.fromEntries(Object.entries(rows[0]).filter(([k]) => k !== '_id')) : null,
        };
        // Extract all unique port strings from Loading Port + Discharge Port
        const portSet = new Set();
        for (const r of rows) {
          if (r["Loading Port"])   portSet.add(String(r["Loading Port"]).trim());
          if (r["Discharge Port"]) portSet.add(String(r["Discharge Port"]).trim());
        }
        result.allPortCodes[name] = [...portSet].sort();
      }
      return res.status(200).json(result);
    }

    if (action === "tradelaneDebug") {
      // Show ALL fields on a sea export job row to find port code fields
      const seaRow = await db.collection("jobs_sea_export").findOne({});
      const isoRow = await db.collection("jobs_isotank_export").findOne({});
      return res.status(200).json({ success: true,
        seaExportFields: seaRow ? Object.keys(seaRow).filter(k=>k!=='_id') : [],
        seaExportSample: seaRow ? Object.fromEntries(Object.entries(seaRow).filter(([k])=>k!=='_id')) : null,
        isoExportFields: isoRow ? Object.keys(isoRow).filter(k=>k!=='_id') : [],
        isoExportSample: isoRow ? Object.fromEntries(Object.entries(isoRow).filter(([k])=>k!=='_id')) : null,
      });
    }

    if (action === "lobCheck") {
      // Shows the actual LOB value distribution inside each collection —
      // use this to verify rows are classified correctly by classifyRow().
      const result = {};
      for (const collName of JOB_COLLECTIONS) {
        const rows = await db.collection(collName).find({}, { projection: { "LOB": 1 } }).toArray();
        const counts = {};
        for (const r of rows) {
          const lob = String(r["LOB"] || "(blank)").trim();
          counts[lob] = (counts[lob] || 0) + 1;
        }
        result[collName] = { totalRows: rows.length, lobBreakdown: counts };
      }
      return res.status(200).json({ success: true, result });
    }

    if (action === "meta") {
      const meta = await db.collection("_meta").findOne({ _id: "lastDataPush" });
      return res.status(200).json({
        success: true,
        lastUpdated: meta?.updatedAt ? meta.updatedAt.toISOString() : null,
      });
    }

    const forceRefresh = req.query?.force === "1" || req.query?.force === "true";

    if (action === "sales") {
      const includeWeek = req.query?.includeWeek === "1";
      const includeLob  = req.query?.includeLob  === "1";

      const strip = (result) => ({ ...result, repsRaw: result.repsRaw.map(r => {
        const copy = { ...r };
        if (!includeWeek) delete copy.weekData;
        if (includeLob) {
          // Full lobData requested — keep as-is
        } else {
          // Always include Ocean primary LOB data (SEA + ISOTANK) for default filter
          if (copy.lobData) {
            const oceanOnly = {};
            if (copy.lobData['SEA EXPORT'])     oceanOnly['SEA EXPORT']     = copy.lobData['SEA EXPORT'];
            if (copy.lobData['SEA IMPORT'])     oceanOnly['SEA IMPORT']     = copy.lobData['SEA IMPORT'];
            if (copy.lobData['ISOTANK EXPORT']) oceanOnly['ISOTANK EXPORT'] = copy.lobData['ISOTANK EXPORT'];
            if (copy.lobData['ISOTANK IMPORT']) oceanOnly['ISOTANK IMPORT'] = copy.lobData['ISOTANK IMPORT'];
            if (copy.lobData['AIR EXPORT'])     oceanOnly['AIR EXPORT']     = copy.lobData['AIR EXPORT'];
            if (copy.lobData['AIR IMPORT'])     oceanOnly['AIR IMPORT']     = copy.lobData['AIR IMPORT'];
            copy.lobData = oceanOnly;
          }
        }
        return copy;
      })});

      // Force refresh: wipe server cache first, then re-fetch from MongoDB
      if (forceRefresh) {
        salesCache = null;
        salesCacheTime = 0;
        drillRowsCache = null;
        drillRowsCacheTime = 0;
      }

      // Bust stale cache if this deployment changed the data logic
      if (salesCache && salesCache._deployTs !== DEPLOY_TS) {
        salesCache = null;
        salesCacheTime = 0;
      }
      if (drillRowsCache && drillRowsCache.deployTs !== DEPLOY_TS) {
        drillRowsCache = null;
        drillRowsCacheTime = 0;
      }

      // Serve from cache unless force refresh
      if (salesCache && !forceRefresh) {
        const isStale = (Date.now() - salesCacheTime) > SALES_CACHE_TTL_MS;
        if (isStale) getSalesAggregate(db, true).catch(() => {});
        return res.status(200).json(strip(salesCache));
      }

      const result = await getSalesAggregate(db, forceRefresh);
      return res.status(200).json(strip(result));
    }

    if (action === "customers") {
      const dateFrom = req.query.dateFrom || null; // e.g. "Jan-26"
      const dateTo   = req.query.dateTo   || null; // e.g. "Jun-26"
      const cacheKey = `${dateFrom}|${dateTo}`;
      const result = await getCustomerAggregate(db, forceRefresh, dateFrom, dateTo, cacheKey);
      return res.status(200).json(result);
    }

    if (action === "agents") {
      const dateFrom = req.query.dateFrom || null;
      const dateTo   = req.query.dateTo   || null;
      const cacheKey = `${dateFrom}|${dateTo}`;
      const result = await getAgentAggregate(db, forceRefresh, dateFrom, dateTo, cacheKey);
      return res.status(200).json(result);
    }

    if (action === "tradelane") {
      const dateFrom = req.query.dateFrom || null;
      const dateTo   = req.query.dateTo   || null;
      const cacheKey = `${dateFrom}|${dateTo}`;
      const result = await getTradelaneAggregate(db, forceRefresh, dateFrom, dateTo, cacheKey);
      return res.status(200).json(result);
    }

    if (action === "usage") {
      const result = await getUsageAnalytics(db, forceRefresh);
      return res.status(200).json(result);
    }

    if (action === "org") {
      const result = await getOrgChart(db);
      return res.status(200).json(result);
    }

    if (action === "drill") {
      const entity = req.query?.entity || req.body?.entity;
      const metric = req.query?.metric || req.body?.metric;
      const month  = req.query?.month  || req.body?.month;
      const lobs   = req.query?.lobs   || req.body?.lobs || "";
      if (!entity || !metric || !month) return res.status(400).json({ error: "entity, metric, and month are required." });
      const result = await getDrillRows(db, entity, metric, month, lobs);
      return res.status(200).json(result);
    }

    if (action === "finance") {
      // Always trigger both pendency caches in one pass
      await _ensurePendencyCache(db, forceRefresh);
      return res.status(200).json(financeCache);
    }

    if (action === "op") {
      // Always trigger both pendency caches in one pass — includes allDrillJobRows
      await _ensurePendencyCache(db, forceRefresh);
      return res.status(200).json(opCache);
    }

    if (action === "pendencyDrill") {
      const repName    = req.query?.rep    || req.body?.rep;
      const month      = req.query?.month  || req.body?.month;
      const lockType   = req.query?.lock   || req.body?.lock;
      const status     = req.query?.status || req.body?.status;
      const entityType = req.query?.type   || req.body?.type || 'rep';
      if (!repName || !lockType) return res.status(400).json({ error: 'rep and lock required' });

      // Load zone mapping for zone-level drill
      const repZoneMap = {};
      if (entityType === 'zone') {
        const mRows = await _getOceanMappingRows(db, {'Sales Rep Name':1,'Display Name':1,'Zone':1});
        for (const r of mRows) {
          const n = normalizeName(r['Sales Rep Name'] || '');
          if (n) repZoneMap[n] = String(r['Zone']||'').trim();
          const d2 = normalizeName(r['Display Name'] || '');
          if (d2) repZoneMap[d2] = String(r['Zone']||'').trim();
        }
      }

      const normRep = normalizeName(repName);
      const isFY = !month || month === 'FY Total';
      const isRange = month && month.startsWith('RANGE:');

      // Build month set for filtering
      let allowedMonths = null; // null = all FY months
      if (!isFY && !isRange && month) {
        allowedMonths = new Set([month]);
      } else if (isRange) {
        const parts = month.split(':');
        const fromM = parts[1], toM = parts[2];
        const fi = FY_MONTHS.indexOf(fromM), ti = FY_MONTHS.indexOf(toM);
        if (fi >= 0 && ti >= 0) {
          allowedMonths = new Set(FY_MONTHS.slice(fi, ti + 1));
        }
      }

      const ALL_JOB_COLLS = Object.values(COLLECTIONS);
      const rows = [];

      await Promise.all(ALL_JOB_COLLS.map(async (collName) => {
        const isExp = collName.includes('export');
        const isImp = collName.includes('import');
        const dateField = isExp ? 'ETD Loading Port' : isImp ? 'ETA Discharge' : 'Job Date';

        // No date filter on MongoDB — match computePendency exactly
        // Use lean projection to keep response small and avoid timeout
        const jobs = await db.collection(collName).find(
          {},
          { projection: { 'Sales Person':1, 'Job Owner':1, 'Financial Lock':1, 'Operation Lock':1,
            [dateField]:1, 'Job Date':1, 'Shipment No':1, 'Customer':1, 'Location':1,
            'Carrier':1, 'Carrier Name':1, 'ETD Loading Port':1, 'ETA Discharge':1 } }
        ).toArray();
        for (const job of jobs) {
          const sp = normalizeName(job['Sales Person'] || '');
          if (!sp) continue;
          if (entityType === 'rep'  && sp !== normRep) continue;
          if (entityType === 'zone' && (repZoneMap[sp]||'') !== repName) continue;

          const rawDate = job[dateField] || job['Job Date'];
          if (!rawDate) continue;
          const d = parseSheetDate(rawDate);
          if (!d) continue;
          const ml = MONTH_NAMES[d.getMonth()] + '-' + String(d.getFullYear()).slice(2);
          if (!FY_MONTHS.includes(ml)) continue;
          // Month filter — null means all FY months, Set means specific months
          if (allowedMonths && !allowedMonths.has(ml)) continue;

          const isDone = job[lockType] && String(job[lockType]).trim() !== '';
          if (status === 'pending' && isDone)  continue;
          if (status === 'done'    && !isDone) continue;

          const cls = classifyRow(job, collName);
          rows.push({
            shipmentNo:   job['Shipment No']     || '—',
            jobDate:      job['Job Date']        || '',
            lob:          cls.kind + (cls.direction ? ' ' + cls.direction : ''),
            customer:     String(job['Customer'] || '').trim() || '—',
            jobOwner:     (job['Job Owner']      || '').split('|')[0].trim() || '—',
            salesPerson:  (job['Sales Person']   || '').split('|')[0].trim() || '—',
            location:     job['Location']        || '—',
            carrier:      job['Carrier'] || job['Carrier Name'] || '—',
            etdLoading:   job['ETD Loading Port']|| '',
            etaDischarge: job['ETA Discharge']   || '',
            lockStatus:   isDone ? 'Done' : 'Pending',
            month:        ml,
          });
        }
      }));

      rows.sort((a, b) => new Date(b.jobDate) - new Date(a.jobDate));
      return res.status(200).json({ success:true, rep:repName, month, lock:lockType, status, count:rows.length, rows });
    }

    if (action === "financeDebug") {
      // Returns unrecognized sales person names (not in mapping)
      const mappingRows = await _getOceanMappingRows(db, { "Sales Rep Name": 1, "Display Name": 1, "Zone": 1 });
      const knownNorms = new Set();
      const knownDisplay = {};
      for (const row of mappingRows) {
        const n1 = normalizeName(row["Sales Rep Name"]);
        const n2 = normalizeName(row["Display Name"] || row["Sales Rep Name"]);
        if (n1) { knownNorms.add(n1); knownDisplay[n1] = { raw: row["Sales Rep Name"], display: row["Display Name"], zone: row["Zone"] }; }
        if (n2) { knownNorms.add(n2); knownDisplay[n2] = { raw: row["Sales Rep Name"], display: row["Display Name"], zone: row["Zone"] }; }
      }
      const ALL_JOB_COLLS = Object.values(COLLECTIONS);
      const unrecognized = {}; // norm → { rawNames: Set, count }
      const recognized = {};
      await Promise.all(ALL_JOB_COLLS.map(async (collName) => {
        const jobs = await db.collection(collName).find({}, { projection: { "Sales Person": 1 } }).toArray();
        for (const job of jobs) {
          const raw = String(job["Sales Person"] || "").trim();
          if (!raw) continue;
          const norm = normalizeName(raw);
          if (knownNorms.has(norm)) {
            if (!recognized[norm]) recognized[norm] = { display: knownDisplay[norm], count: 0 };
            recognized[norm].count++;
          } else {
            if (!unrecognized[norm]) unrecognized[norm] = { rawNames: [], count: 0 };
            if (!unrecognized[norm].rawNames.includes(raw)) unrecognized[norm].rawNames.push(raw);
            unrecognized[norm].count++;
          }
        }
      }));
      return res.status(200).json({
        success: true,
        unrecognized: Object.entries(unrecognized).sort((a,b) => b[1].count - a[1].count).map(([norm, v]) => ({ norm, rawNames: v.rawNames, count: v.count })),
        recognizedCount: Object.keys(recognized).length,
        mapping: mappingRows.map(r => ({ raw: r["Sales Rep Name"], display: r["Display Name"], zone: r["Zone"] }))
      });
    }

    if (action === "deleteUser") {
      const { email } = req.body || {};
      if (!email) return res.status(400).json({ error: "email required" });
      await db.collection("users").deleteOne({ email: email.toLowerCase().trim() });
      return res.status(200).json({ success: true });
    }

    if (action === "addUser") {
      const { email, name, role, zone, reportsTo } = req.body || {};
      if (!email || !name) return res.status(400).json({ error: "email and name required" });
      const newUser = {
        email: email.toLowerCase().trim(),
        name: name.trim(),
        role: role || "Sales Rep",
        zone: zone || "",
        region: (req.body || {}).region || "",
        reportsTo: (reportsTo || "").toLowerCase().trim(),
        isActive: true,
        loginCount: 0,
        createdAt: new Date(),
      };
      const existing = await db.collection("users").findOne({ email: newUser.email });
      if (existing) return res.status(400).json({ error: "User with this email already exists" });
      await db.collection("users").insertOne(newUser);
      const updatedOrg = await getOrgChart(db);
      return res.status(200).json({ success: true, org: updatedOrg });
    }

    if (action === "updateUser") {
      const { email, role, reportsTo, zone, region, isActive, name } = req.body || {};
      const result = await updateUserFields(db, email, { role, reportsTo, zone, region, isActive, name });
      if (result.error) return res.status(400).json({ error: result.error });
      return res.status(200).json({ success: true, ...result });
    }

    if (action === "jobs") {
      const { records, clearFirst = true, fy = null } = req.body || {};
      if (!records) return res.status(400).json({ error: "records required" });
      const { summary, errors } = await batchInsertJobs(db, records, clearFirst, fy);
      salesCache = null; // invalidate in-memory cache — fresh data was just pushed
      await db.collection("_meta").updateOne(
        { _id: "lastDataPush" },
        { $set: { updatedAt: new Date() } },
        { upsert: true }
      );
      return res.status(200).json({
        success: true, action: "jobs", summary,
        totalInserted: Object.values(summary).reduce((s, n) => s + n, 0),
        ...(errors.length ? { errors } : {}),
      });
    }

    if (action === "mapping") {
      const { collectionName, records, fy = null } = req.body || {};
      if (!collectionName || !records) return res.status(400).json({ error: "collectionName and records required" });
      const result = await batchInsertMapping(db, collectionName, records, fy);
      if (result.error) return res.status(400).json({ error: result.error });
      return res.status(200).json({ success: true, action: "mapping", collection: collectionName, inserted: result.inserted });
    }

    if (action === "srr") {
      const { collectionName, records, fy } = req.body || {};
      const ALLOWED_SRR = new Set(["srr_sea_export","srr_sea_import","srr_air_export","srr_air_import","srr_isotank_export","srr_isotank_import"]);
      if (!collectionName || !ALLOWED_SRR.has(collectionName)) {
        return res.status(400).json({ error: "collectionName must be one of: " + [...ALLOWED_SRR].join(", ") });
      }
      if (!records || !Array.isArray(records)) return res.status(400).json({ error: "records array required" });
      const col = db.collection(collectionName);

      // Sanitize field names: MongoDB forbids dots in field names used in update paths.
      // Replace dots with a visually identical Unicode middle dot (U+FF0E fullwidth) so
      // the original column name is preserved for display but won't break $set paths.
      function sanitizeKeys(rec) {
        const out = {};
        for (const [k, v] of Object.entries(rec)) {
          out[k.replace(/\./g, '\uFF0E')] = v;
        }
        return out;
      }
      // Stamp _fy if provided so we can do FY-scoped wipes (both FYs coexist in one collection)
      const sanitizedRecords = records.map(rec => {
        const s = sanitizeKeys(rec);
        if (fy) s._fy = fy;
        return s;
      });

      // Upsert by shipment number so FY26 + FY27 can both push without wiping each other
      const KEY_CANDIDATES = ["Shipment No", "Shipment No\uFF0E", "Shipment No.", "Job No", "Job No.", "House No", "House No.", "Shipment Number", "Job Number"];
      let keyField = null;
      if (sanitizedRecords[0]) {
        for (const k of KEY_CANDIDATES) {
          if (sanitizedRecords[0][k] !== undefined) { keyField = k; break; }
        }
      }

      let inserted = 0, updated = 0;
      const CHUNK = 200;
      for (let i = 0; i < sanitizedRecords.length; i += CHUNK) {
        const chunk = sanitizedRecords.slice(i, i + CHUNK);
        if (keyField) {
          const ops = chunk.map(rec => ({
            updateOne: {
              filter: fy ? { [keyField]: rec[keyField], _fy: fy } : { [keyField]: rec[keyField] },
              update: { $set: rec },
              upsert: true,
            }
          }));
          const r = await col.bulkWrite(ops, { ordered: false });
          inserted += r.upsertedCount || 0;
          updated  += r.modifiedCount || 0;
        } else {
          await col.insertMany(chunk, { ordered: false });
          inserted += chunk.length;
        }
      }
      Object.keys(tradelaneCacheMap).forEach(k => delete tradelaneCacheMap[k]);
      return res.status(200).json({ success: true, collection: collectionName, inserted, updated, keyField });
    }

    if (action === "wipeSRRByFY") {
      // Wipe only one FY's SRR data — safe to run before re-pushing a single year
      const { collection: collName, fy } = req.body || {};
      const ALLOWED_SRR = ["srr_sea_export","srr_sea_import","srr_air_export","srr_air_import","srr_isotank_export","srr_isotank_import"];
      if (!collName || !ALLOWED_SRR.includes(collName)) return res.status(400).json({ error: "unknown collection" });
      if (!fy || !["FY26","FY27","FY28"].includes(fy)) return res.status(400).json({ error: "fy must be FY26, FY27 or FY28" });
      const result = await db.collection(collName).deleteMany({ _fy: fy });
      return res.json({ success: true, deleted: result.deletedCount, collection: collName, fy });
    }

    if (action === "wipeCollection") {
      // Wipe an entire job or SRR collection so Apps Script can re-push clean data
      const collName = (req.body && req.body.collection) || req.query.collection;
      if (!collName) return res.status(400).json({ error: "collection required" });
      const WIPEABLE_COLLS = [
        "jobs_air_export","jobs_air_import","jobs_sea_export","jobs_sea_import",
        "jobs_isotank_export","jobs_isotank_import","jobs_general","jobs_road",
        "jobs_clearance_export","jobs_clearance_import",
        "srr_air_export","srr_air_import","srr_sea_export","srr_sea_import",
        "srr_isotank_export","srr_isotank_import",
        "ocean_mapping_sales_targets","ocean_mapping_zone_targets",
      ];
      if (!WIPEABLE_COLLS.includes(collName)) return res.status(400).json({ error: "unknown collection" });
      const result = await db.collection(collName).deleteMany({});
      return res.json({ success: true, deleted: result.deletedCount, collection: collName });
    }

    if (action === "dedup") {
      // Remove duplicate Shipment No entries — keep the document with the latest _insertedAt (or _id)
      const results = {};
      for (const collName of JOB_COLLECTIONS) {
        const col = db.collection(collName);
        // Find all docs grouped by Shipment No
        const pipeline = [
          { $group: { _id: "$Shipment No", count: { $sum: 1 }, ids: { $push: "$_id" } } },
          { $match: { count: { $gt: 1 } } }
        ];
        const dupes = await col.aggregate(pipeline).toArray();
        let removed = 0;
        for (const dupe of dupes) {
          // Keep first, delete the rest
          const toDelete = dupe.ids.slice(1);
          const r = await col.deleteMany({ _id: { $in: toDelete } });
          removed += r.deletedCount;
        }
        results[collName] = { duplicateGroups: dupes.length, removed };
      }
      // Bust caches after dedup
      salesCache = null; salesCacheTime = 0;
      drillRowsCache = null; drillRowsCacheTime = 0;
      return res.status(200).json({ success: true, action: "dedup", results });
    }

    if (action === "users") {
      const { users } = req.body || {};
      if (!users) return res.status(400).json({ error: "users array required" });
      const results = await batchUpsertUsers(db, users);
      return res.status(200).json({ success: true, action: "users", inserted: results.inserted, updated: results.updated, ...(results.errors.length ? { errors: results.errors } : {}) });
    }

    return res.status(400).json({ error: `Unknown action: "${action}"` });

  } catch (err) {
    console.error("❌ Batch error:", err.message);
    return res.status(500).json({ error: "Batch operation failed", detail: err.message });
  }
};
