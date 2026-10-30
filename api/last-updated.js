// GET /api/last-updated → { lastUpdated: ISO string | null }
// When fresh data last arrived in this dashboard's database. Read by the SAR Systems Hub for the
// "Updated …" line on this dashboard's card. Returns a single timestamp, no data, so it needs no
// sign-in.
//
// The Ocean and Air Sales dashboards share the "sar-in-air-sales" database, so a push from either
// one updates this time on both.
const { MongoClient } = require("mongodb");

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME   = "sar-in-air-sales";
// Job pushes stamp _meta.lastDataPush; SRR pushes stamp _meta.lastPush_srr (api/mongo-batch.js).
const PUSH_STAMPS = ["lastDataPush", "lastPush_srr"];

let cachedClient = null;
async function getDB() {
  if (!cachedClient) {
    cachedClient = new MongoClient(MONGO_URI, { maxPoolSize: 2, serverSelectionTimeoutMS: 8000 });
    await cachedClient.connect();
  }
  return cachedClient.db(DB_NAME);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const db = await getDB();
    const stamps = await db.collection("_meta")
      .find({ _id: { $in: PUSH_STAMPS } }, { projection: { updatedAt: 1 } })
      .toArray();
    const times = stamps.map((d) => new Date(d.updatedAt).getTime()).filter((t) => !isNaN(t));
    return res.status(200).json({ lastUpdated: times.length ? new Date(Math.max(...times)).toISOString() : null });
  } catch (err) {
    console.error("last-updated:", err.message);
    return res.status(500).json({ lastUpdated: null });
  }
};
