// ─────────────────────────────────────────────────────────────────
//  api/sso-verify.js  —  Vercel Serverless Function
//  Endpoint:  POST /api/sso-verify
//  Receives an SSO launch handoff from the SAR Systems Hub
//  (https://systems.sarlogisolutions.com) and, if the user is a
//  valid Ocean dashboard user, hands back a page that writes a
//  pending-profile marker + widget token into sessionStorage and
//  redirects to "/", where the existing boot logic on index.html
//  picks it up and runs it through the same login path a normal
//  Google sign-in already uses (verifyWithBackend -> /api/mongo).
// ─────────────────────────────────────────────────────────────────

const { jwtVerify } = require("jose");
const { MongoClient } = require("mongodb");

const HUB_ISSUER         = "sar-systems-hub";
const DEFAULT_HUB_ORIGIN = "https://systems.sarlogisolutions.com";

const KNOWN_DASHBOARD_SLUGS = ["stspl-ocean-sales-test", "ocean-sales-performance"];
const DEFAULT_DASHBOARD_SLUG = "ocean-sales-performance";

const MONGO_URI        = process.env.MONGO_URI;
const DB_NAME          = "sar-in-air-sales";
const COLLECTION_USERS = "ocean_users";

let cachedClient = null;

async function getDB() {
  if (cachedClient) return cachedClient.db(DB_NAME);
  cachedClient = new MongoClient(MONGO_URI, {
    connectTimeoutMS: 10000,
    serverSelectionTimeoutMS: 10000,
  });
  await cachedClient.connect();
  return cachedClient.db(DB_NAME);
}

function getSecretKey() {
  const secret = process.env.SSO_SHARED_SECRET;
  if (!secret) throw new Error("SSO_SHARED_SECRET is not set");
  return new TextEncoder().encode(secret);
}

// Only trust a hub_origin the Hub itself could plausibly send — its real
// production domain, or one of its own Vercel preview/staging deployments —
// never an arbitrary attacker-supplied origin used to load a foreign script.
function sanitizeHubOrigin(rawOrigin) {
  if (!rawOrigin) return DEFAULT_HUB_ORIGIN;
  try {
    const parsed = new URL(rawOrigin);
    if (parsed.protocol !== "https:") return DEFAULT_HUB_ORIGIN;
    const host = parsed.hostname;
    const isProd = host === "systems.sarlogisolutions.com";
    const isHubPreview = /^dashboards(-[a-z0-9]+)?-git-[a-z0-9-]+-sar-strategy\.vercel\.app$/.test(host);
    if (isProd || isHubPreview) return parsed.origin;
  } catch (_) {}
  return DEFAULT_HUB_ORIGIN;
}

function renderHandoffPage(profile, widgetToken, slug, hubOrigin) {
  const profileJson     = JSON.stringify(profile).replace(/</g, "\\u003c");
  const widgetTokenJson = JSON.stringify(widgetToken || "").replace(/</g, "\\u003c");
  const slugJson        = JSON.stringify(slug).replace(/</g, "\\u003c");
  const hubOriginJson   = JSON.stringify(hubOrigin).replace(/</g, "\\u003c");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body>
  <p>Signing you in…</p>
  <script>
    try {
      sessionStorage.setItem('sar_hub_pending_profile', JSON.stringify(${profileJson}));
      var widgetToken = ${widgetTokenJson};
      if (widgetToken) {
        sessionStorage.setItem('sar_hub_widget_token', widgetToken);
        sessionStorage.setItem('sar_hub_current_slug', ${slugJson});
        sessionStorage.setItem('sar_hub_origin', ${hubOriginJson});
      }
    } catch (e) {}
    location.replace('/');
  </script>
</body></html>`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  const body = req.body || {};
  const token = body.sso_token;
  if (!token) return res.status(400).send("Missing sso_token");
  const widgetToken = body.widget_token;
  const hubOrigin = sanitizeHubOrigin(body.hub_origin);

  let payload;
  try {
    const verified = await jwtVerify(token, getSecretKey(), { issuer: HUB_ISSUER });
    payload = verified.payload;
  } catch (err) {
    console.error("sso-verify: jwtVerify failed:", err.code || err.name, err.message);
    return res.status(401).send("Invalid or expired sign-in link. Please return to the Hub and try again.");
  }

  const email = (payload.email || "").toLowerCase().trim();
  if (!email) return res.status(400).send("Token missing email");

  const tokenSlug = typeof payload.slug === "string" ? payload.slug.trim() : "";
  const dashboardSlug = KNOWN_DASHBOARD_SLUGS.includes(tokenSlug) ? tokenSlug : DEFAULT_DASHBOARD_SLUG;

  try {
    const db = await getDB();
    const user = await db.collection(COLLECTION_USERS).findOne(
      { email, isActive: true },
      { projection: { name: 1, email: 1, role: 1, photoUrl: 1, reportsTo: 1, zone: 1, region: 1 } }
    );

    if (!user) {
      console.warn("sso-verify: unauthorized access attempt:", email);
      return res.status(403).send("Access denied. Your account is not registered in this dashboard. Contact your administrator.");
    }

    const now = new Date();
    await db.collection(COLLECTION_USERS).updateOne(
      { email },
      { $set: { lastLogin: now }, $inc: { loginCount: 1 } }
    );
    await db.collection("login_events").insertOne({
      email,
      name: user.name,
      timestamp: now,
      dashboard: "ocean",
      via: "hub-sso",
    });

    // Shaped exactly like the userinfo object verifyWithBackend() in
    // index.html already sends to /api/mongo, so the existing boot logic
    // can hand it to the same login path unchanged.
    const profile = { email: user.email, name: user.name, picture: user.photoUrl || "" };

    console.log("✅ SSO handoff success:", email, "| role:", user.role);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(renderHandoffPage(profile, widgetToken, dashboardSlug, hubOrigin));

  } catch (err) {
    console.error("❌ sso-verify error:", err.message);
    return res.status(500).send("Sign-in failed. Please try again.");
  }
};
