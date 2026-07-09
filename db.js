import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.warn("WARNING: MONGODB_URI is not set. Database operations will fail until you set it.");
}

let client;
let db;

export async function connectDb() {
  if (db) return db;
  if (!uri) {
    throw new Error("MONGODB_URI environment variable is not set or is empty. Check Render's Environment tab — the variable name must be exactly 'MONGODB_URI', and the service needs a redeploy after adding/changing it.");
  }
  client = new MongoClient(uri);
  await client.connect();
  db = client.db("matchbook");
  // id is our own string identifier (e.g. "SL-10240"), not Mongo's _id —
  // keeps the shape identical to what the frontend already expects.
  await db.collection("trades").createIndex({ id: 1 }, { unique: true });
  console.log("Connected to MongoDB");
  return db;
}

export async function getTrades() {
  const database = await connectDb();
  return database.collection("trades").find({}).project({ _id: 0 }).toArray();
}

export async function getTrade(id) {
  const database = await connectDb();
  return database.collection("trades").findOne({ id }, { projection: { _id: 0 } });
}

export async function insertTrade(trade) {
  const database = await connectDb();
  await database.collection("trades").insertOne({ ...trade });
  return trade;
}

export async function updateTrade(id, updates) {
  const database = await connectDb();
  await database.collection("trades").updateOne({ id }, { $set: updates });
  return getTrade(id);
}

export async function replaceAllTrades(trades) {
  const database = await connectDb();
  const ops = trades.map(t => ({
    updateOne: { filter: { id: t.id }, update: { $set: t }, upsert: true },
  }));
  if (ops.length > 0) await database.collection("trades").bulkWrite(ops);
}

export async function deleteTrade(id) {
  const database = await connectDb();
  await database.collection("trades").deleteOne({ id });
}

// Single settings document: schedule config + last-known prices, so the
// backend's own scheduled runs have everything they need without
// depending on the frontend to supply it.
const SETTINGS_ID = "singleton";

export async function getSettings() {
  const database = await connectDb();
  const doc = await database.collection("settings").findOne({ _id: SETTINGS_ID });
  return doc || {
    _id: SETTINGS_ID,
    autoScheduleEnabled: true,
    mtmScheduleTime: "16:30",
    lastAutoRunDate: null,
    lastMtmRun: null,
    prices: {},
    benchmark: null,
  };
}

export async function updateSettings(updates) {
  const database = await connectDb();
  await database.collection("settings").updateOne(
    { _id: SETTINGS_ID },
    { $set: updates },
    { upsert: true }
  );
  return getSettings();
}
