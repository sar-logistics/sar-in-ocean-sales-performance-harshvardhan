// ─────────────────────────────────────────────────────────────────
//  api/mongo.js  —  Vercel Serverless Function
//  Endpoint:  POST /api/mongo
//  Body:      { email, name, picture }  (from Google userinfo)
//  Returns:   { success, user: { name, email, role, photoUrl } }
// ─────────────────────────────────────────────────────────────────

const { MongoClient } = require("mongodb");

const MONGO_URI        = process.env.MONGO_URI;
const DB_NAME          = "sar-in-air-sales";  // Option B: shared DB
const COLLECTION_USERS = "users";

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

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const { email: rawEmail, name, picture } = req.body || {};

  if (!rawEmail) {
    return res.status(400).json({ error: "email is required in request body." });
  }

  const email = rawEmail.toLowerCase().trim();

  try {
    const db   = await getDB();
    const user = await db.collection(COLLECTION_USERS).findOne(
      { email, isActive: true },
      { projection: { name: 1, email: 1, role: 1, photoUrl: 1, reportsTo: 1, zone: 1, region: 1 } }
    );

    if (!user) {
      console.warn("Unauthorized access attempt:", email);
      return res.status(403).json({
        error:   "Access denied",
        message: "Your account is not authorized. Contact Harshvardhan Rawat.",
      });
    }

    const now = new Date();

    await db.collection(COLLECTION_USERS).updateOne(
      { email },
      {
        $set: {
          lastLogin: now,
          ...(picture ? { photoUrl: picture } : {}),
        },
        $inc: { loginCount: 1 },
      }
    );

    await db.collection("login_events").insertOne({
      email,
      name: user.name,
      timestamp: now,
    });

    console.log("✅ Auth success:", email, "| role:", user.role);
    return res.status(200).json({
      success: true,
      user: {
        name:      user.name,
        email:     user.email,
        role:      user.role,
        photoUrl:  picture || user.photoUrl || "",
        reportsTo: user.reportsTo || "",
        zone:      user.zone || "",
        region:    user.region || "",
      },
    });

  } catch (err) {
    console.error("❌ Auth error:", err.message);
    return res.status(500).json({ error: "Authentication failed", detail: err.message });
  }
};
