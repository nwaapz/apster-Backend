// index.js
import express from "express";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import { ethers } from "ethers";
import {
  readDBSync,
  writeDBAtomicAsync,
  computePeriod,
  processPeriod,
  normalizeProfileName
} from "./leaderboard.js";

dotenv.config();

const PORT = Number(process.env.PORT || 3001);
const DURATION_MS = Number(process.env.DURATION_MS || 3600000);
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 * * * *";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const RPC_URL = process.env.RPC_URL;
let PRIVATE_KEY = process.env.PRIVATE_KEY;
const HOUSE_FEE_BPS = Number(process.env.HOUSE_FEE_BPS || 100);
const TOP_N = Number(process.env.TOP_N || 3);
const DB_FILE = path.resolve(process.env.DB_FILE || "./periods.json");
const FLUSH_INTERVAL_MS = Number(process.env.FLUSH_INTERVAL_MS || 20000);
const GAS_LIMIT = Number(process.env.GAS_LIMIT || 2_000_000);

if (!CONTRACT_ADDRESS || !RPC_URL || !PRIVATE_KEY) {
  console.error("Set CONTRACT_ADDRESS, RPC_URL, PRIVATE_KEY in .env");
  process.exit(1);
}
if (!PRIVATE_KEY.startsWith("0x")) PRIVATE_KEY = "0x" + PRIVATE_KEY;

const ABI_PATH = path.resolve("./abi/WagerPoolSingleEntry.json");
if (!fs.existsSync(ABI_PATH)) {
  console.error("ABI missing at", ABI_PATH);
  process.exit(1);
}
const contractJson = JSON.parse(fs.readFileSync(ABI_PATH, "utf8"));
const provider = new ethers.JsonRpcProvider(RPC_URL);
const ownerWallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, contractJson.abi, ownerWallet);

// --- In-memory DB ---
let db = readDBSync(DB_FILE);
let flushing = false;

async function flushAsync() {
  if (flushing) return;
  flushing = true;
  try { await writeDBAtomicAsync(DB_FILE, db); }
  catch (err) { console.error("Flush failed:", err); }
  finally { flushing = false; }
}
setInterval(flushAsync, FLUSH_INTERVAL_MS);

// --- Graceful shutdown ---
function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Flushing DB and exiting...`);
  clearInterval(flushAsync);
  flushAsync().finally(() => process.exit(0));
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// --- Express ---
const app = express();
app.use(cors());
app.use(express.json());
app.get("/", (req,res) => res.send("✅ Backend running!"));

// Submit score
app.post("/api/submit-score", (req,res) => {
  try {
    const { user, score, profile_name, email } = req.body;
    if (!user || score === undefined || score === null) return res.status(400).json({ ok:false, error:"Missing user or score" });

    const addr = String(user).trim().toLowerCase();
    const intScore = Math.floor(Number(score)||0);

    db.scores[addr] = db.scores[addr] || { user_address: addr, email:null, profile_name:null, highest_score:0, games_played:0, last_score:null, last_updated:new Date().toISOString() };

    if (profile_name) db.scores[addr].profile_name = profile_name.trim();
    if (email) db.scores[addr].email = String(email).trim();

    db.scores[addr].last_score = intScore;
    db.scores[addr].games_played += 1;
    if (intScore > db.scores[addr].highest_score) db.scores[addr].highest_score = intScore;
    db.scores[addr].last_updated = new Date().toISOString();

    return res.json({ ok:true, saved: db.scores[addr] });
  } catch(err) {
    console.error("submit-score error:", err);
    return res.status(500).json({ ok:false, error:String(err) });
  }
});

// Update profile name
app.post("/api/update-profile", (req,res) => {
  try {
    const { user, profile_name } = req.body;
    if (!user || !profile_name) return res.status(400).json({ ok:false, error:"Missing user or profile_name" });

    const addr = String(user).trim().toLowerCase();
    const raw = String(profile_name).trim();
    const normalized = normalizeProfileName(raw);

    if (!db.profileNames) db.profileNames = {};
    if (!db.scores) db.scores = {};

    const existingOwner = db.profileNames[normalized];
    if (existingOwner && existingOwner !== addr) return res.status(409).json({ ok:false, error:"profile_name already exists" });

    // Remove old name index
    const prev = db.scores[addr]?.profile_name;
    if (prev && db.profileNames[normalizeProfileName(prev)] === addr) delete db.profileNames[normalizeProfileName(prev)];

    db.scores[addr] = db.scores[addr] || { user_address: addr, email:null, profile_name:null, highest_score:0, games_played:0, last_updated:new Date().toISOString() };
    db.scores[addr].profile_name = raw;
    db.scores[addr].last_updated = new Date().toISOString();
    db.profileNames[normalized] = addr;

    return res.json({ ok:true, message:"profile_name set", saved: db.scores[addr] });
  } catch(err) {
    console.error("/api/update-profile error:", err);
    return res.status(500).json({ ok:false, error:String(err) });
  }
});

// Leaderboard
let leaderboardCache = [];
function refreshLeaderboardCache() {
  leaderboardCache = Object.values(db.scores)
    .sort((a,b) => (b.highest_score||0)-(a.highest_score||0))
    .slice(0, 100);
}
setInterval(refreshLeaderboardCache, 5000);

app.get("/api/leaderboard", (req,res) => {
  const limit = Math.min(100, Number(req.query.limit||10));
  return res.json({ ok:true, count: leaderboardCache.length, leaderboard: leaderboardCache.slice(0,limit) });
});

// Period info
app.get("/api/period", (req,res) => {
  try {
    const { periodIndex, periodStart, periodEnd } = computePeriod(Date.now(), DURATION_MS);
    const record = db.periods[periodIndex] || null;
    return res.json({ periodIndex, periodStart, periodEnd, durationMs:DURATION_MS, status:record?.status||"open", lastPayoutTx:record?.txHash||null, payouts:record?.payouts||null });
  } catch(err) { return res.status(500).json({ ok:false, error:String(err) }); }
});

// Process now
app.post("/api/process-now", async (req,res) => {
  try {
    const ts = Date.now()-1000;
    const { periodIndex } = computePeriod(ts, DURATION_MS);
    await processPeriod(contract, db, periodIndex, TOP_N, HOUSE_FEE_BPS, { gasLimit:GAS_LIMIT });
    return res.json({ ok:true, record: db.periods[periodIndex]||null });
  } catch(err) { return res.status(500).json({ ok:false, error:String(err) }); }
});

// --- Cron ---
cron.schedule(CRON_SCHEDULE, async () => {
  try {
    const { periodIndex } = computePeriod(Date.now()-1000, DURATION_MS);
    console.log("Cron processing period", periodIndex, new Date().toISOString());
    await processPeriod(contract, db, periodIndex, TOP_N, HOUSE_FEE_BPS, { gasLimit:GAS_LIMIT });
  } catch(err){ console.error("Cron error:", err); }
}, { timezone:"UTC" });

// --- Start server ---
app.listen(PORT, ()=>console.log(`Server listening on ${PORT}`));
