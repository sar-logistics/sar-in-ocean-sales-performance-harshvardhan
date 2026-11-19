// Incentive payout run, worked out on the server from a quarter's frozen data.
//
// The numbers must be exactly the ones the Incentive pages show, so this doesn't copy the calculation: it runs the
// page's own script (index.html) in a sandbox with no browser around it, puts the frozen data in place the same way
// the page does (_incWithData) and calls the page's _incBuildRun. The result goes to incentiveRunSave like any run.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let CTX = null;

function pageHtml() {
  const tries = [path.join(__dirname, "..", "index.html"), path.join(process.cwd(), "index.html")];
  for (const p of tries) { try { return fs.readFileSync(p, "utf8"); } catch (e) { /* next */ } }
  throw new Error("index.html not found next to the API (vercel.json includeFiles)");
}

// Anything the page touches in the browser (document, google, XLSX…) is absorbed: every property and call gives back
// another stand-in, so set-up code that draws or listens does nothing.
function standIn() {
  const f = function () {};
  return new Proxy(f, {
    get: (t, k) => {
      if (k === Symbol.toPrimitive) return () => "";
      if (k === "then") return undefined;
      if (k === Symbol.iterator) return function* () {};
      if (k === "length") return 0;
      return standIn();
    },
    apply: () => standIn(),
    construct: () => standIn(),
    set: () => true,
  });
}

function engine() {
  if (CTX) return CTX;
  const html = pageHtml();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const mem = {};
  const quiet = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  const Obs = function () { return { observe() {}, disconnect() {}, unobserve() {} }; };
  const ctx = {
    console: quiet, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0,
    document: standIn(), history: standIn(), google: standIn(), XLSX: standIn(),
    navigator: { userAgent: "server" }, location: { href: "https://server/", hostname: "server", search: "", hash: "", pathname: "/" },
    localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: () => new Promise(() => {}), addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }), getComputedStyle: () => standIn(),
    innerWidth: 1400, innerHeight: 900, Image: function () {}, MutationObserver: Obs, ResizeObserver: Obs, IntersectionObserver: Obs,
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  scripts.forEach((s, i) => vm.runInContext(s, ctx, { filename: "index.html#script" + i }));
  if (typeof ctx._incBuildRun !== "function" || typeof ctx._incWithData !== "function")
    throw new Error("index.html has no _incBuildRun / _incWithData");
  CTX = ctx;
  return ctx;
}

// st = incentiveLockState(quarter) (frozen), parts = { sales, ar, rows } as stored, held = [{ key, s, part, rep }]
function buildRunFromFrozen(st, parts, held) {
  const ctx = engine();
  ctx.__incIn = { st, sales: parts.sales || {}, ar: parts.ar || {}, rows: parts.rows || [], held: held || [] };
  try {
    // Same steps as the page's _incFrozenLoad, then the run exactly as the page builds it
    return JSON.parse(JSON.stringify(vm.runInContext(`(function(){
      var I = __incIn, sales = I.sales, ar = I.ar;
      var order = function(m){ var b = String(m).split('-'); return (2000 + parseInt(b[1], 10)) * 12 + MONTH_NAME_TO_IDX[b[0]]; };
      var refs = {}; (ar.refs || []).forEach(function(k){ refs[k] = true; });
      var F = { meta:I.st.frozen, rawRows:I.rows, allDrillRows:null,
        repsRawOriginal:sales.repsRaw || [], zonesRaw:sales.zones || [],
        months26:(sales.months || []).slice().sort(function(a, b){ return order(a) - order(b); }),
        incOutRefs:refs, incLateRefs:ar.lateRefs || {},
        incOutMeta:{ asOn:ar.asOn, docsWithRef:ar.docsWithRef || 0, fields:ar.fields || null, paidDocs:ar.paidDocs || 0, lateDays:ar.lateDays || 30, pushedAt:ar.pushedAt || null } };
      dataReady = true;
      currentUser = { name:'Nightly server job', email:'', role:'Admin' };   // sees every rep
      return _incWithData(F, function(){
        buildZoneAggregates();
        return _incBuildRun({ key:I.st.quarter, label:I.st.label, months:I.st.months }, I.held);
      });
    })()`, ctx)));
  } finally {
    ctx.__incIn = null;
  }
}

module.exports = { buildRunFromFrozen };
