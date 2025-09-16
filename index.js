// index.js - backend (full file)
// Node/ES module expected (top-level await used)
import express from "express";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import { ethers } from "ethers";
import { Pool } from "pg";
import {
  initDB,
  saveScore,
  saveProfileName,
  savePeriod,
  computePeriod,
  processPeriod,
  normalizeProfileName,
  getLeaderboard
} from "./leaderboard.js";
import registerAdminRoutes from "./adminRoutes.js";

dotenv.config();

const PORT = Number(process.env.PORT || 3001);
const DURATION_MS = Number(process.env.DURATION_MS || 3600000);
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 * * * *";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const RPC_URL = process.env.RPC_URL;
let PRIVATE_KEY = process.env.PRIVATE_KEY;
const HOUSE_FEE_BPS = Number(process.env.HOUSE_FEE_BPS || 100);
const TOP_N = Number(process.env.TOP_N || 3);
const GAS_LIMIT = Number(process.env.GAS_LIMIT || 2_000_000);
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

// Basic env validation for on-chain parts (if you're running without contract, set env accordingly)
if (!CONTRACT_ADDRESS || !RPC_URL || !PRIVATE_KEY) {
  console.error("Set CONTRACT_ADDRESS, RPC_URL, PRIVATE_KEY in .env (or disable on-chain features).");
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

// --- Postgres pool ---
if (!process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL in env (Postgres connection string)");
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render (managed Postgres) usually requires SSL; allow override via PGSSLMODE=no
  ssl: process.env.PGSSLMODE === "no" ? false : { rejectUnauthorized: false }
});

// --- Load DB cache (async) ---
let db;
try {
  db = await initDB(pool);
  console.log("DB cache loaded (Postgres)");
} catch (err) {
  console.error("Failed to initialize DB:", err);
  process.exit(1);
}

// --- Express ---
const app = express();
app.use(cors());
app.use(express.json());

// Register admin routes, provide pool to adminRoutes


registerAdminRoutes(app, db, {
  pool,
  adminSecret: ADMIN_SECRET,
  contractAddress: CONTRACT_ADDRESS,
  contractAbi: contractJson.abi, // ✅ use this instead
  rpcUrl: RPC_URL
});


// Root
app.get("/", (req,res) => res.send("✅ Backend running (Postgres)!"));

// Submit score (now accepts optional 'level' + profile_name + email)
app.post("/api/submit-score", async (req,res) => {
  try {
    const { user, score, profile_name, email, level } = req.body;
    if (!user || score === undefined || score === null) return res.status(400).json({ ok:false, error:"Missing user or score" });

    const addr = String(user).trim().toLowerCase();
    const intScore = Math.floor(Number(score) || 0);
    const intLevel = Number.isFinite(Number(level)) ? Math.max(1, Math.floor(Number(level))) : (db.scores?.[addr]?.level || 1);

    if (!db.scores) db.scores = {};

    db.scores[addr] = db.scores[addr] || {
      user_address: addr,
      email: null,
      profile_name: null,
      highest_score: 0,
      games_played: 0,
      last_score: null,
      level: intLevel,
      last_updated: new Date().toISOString()
    };

    if (profile_name) db.scores[addr].profile_name = String(profile_name).trim();
    if (email) db.scores[addr].email = String(email).trim();

    db.scores[addr].last_score = intScore;
    db.scores[addr].games_played = Number(db.scores[addr].games_played || 0) + 1;
    db.scores[addr].level = intLevel;
    if (intScore > Number(db.scores[addr].highest_score || 0)) db.scores[addr].highest_score = intScore;
    db.scores[addr].last_updated = new Date().toISOString();

    // persist to Postgres (saveScore will update db cache too)
    await saveScore(pool, db, db.scores[addr]);

    return res.json({ ok:true, saved: db.scores[addr] });
  } catch(err) {
    console.error("submit-score error:", err);
    return res.status(500).json({ ok:false, error:String(err) });
  }
});

// Update profile name
app.post("/api/update-profile", async (req,res) => {
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

    // Remove old name index (if owned by this addr)
    const prev = db.scores[addr]?.profile_name;
    if (prev && db.profileNames[normalizeProfileName(prev)] === addr) {
      const oldNormalized = normalizeProfileName(prev);
      await pool.query(`DELETE FROM profile_names WHERE normalized_name = $1 AND owner_address = $2`, [oldNormalized, addr]);
      delete db.profileNames[oldNormalized];
    }

    db.scores[addr] = db.scores[addr] || {
      user_address: addr, email:null, profile_name:null, highest_score:0, games_played:0, level:1, last_updated:new Date().toISOString()
    };
    db.scores[addr].profile_name = raw;
    db.scores[addr].last_updated = new Date().toISOString();

    // persist score first (ensure FK target exists), then profile name
    await saveScore(pool, db, db.scores[addr]);
    await saveProfileName(pool, db, normalized, addr);

    return res.json({ ok:true, message:"profile_name set", saved: db.scores[addr] });
  } catch(err) {
    console.error("/api/update-profile error:", err);
    return res.status(500).json({ ok:false, error:String(err) });
  }
});

// Leaderboard cache kept in-memory and refreshed periodically (uses getLeaderboard)
let leaderboardCache = [];
function refreshLeaderboardCache() {
  try {
    const result = getLeaderboard(db, 100, null); // top 100 cached
    leaderboardCache = result.leaderboard || [];
  } catch (err) {
    console.error("refreshLeaderboardCache error:", err);
    leaderboardCache = Object.values(db.scores || {})
      .sort((a,b) => (Number(b.highest_score||0) - Number(a.highest_score||0)))
      .slice(0, 100);
  }
}
refreshLeaderboardCache();
setInterval(refreshLeaderboardCache, 5000);

// New /api/leaderboard route: top N + optional user record + rank
app.get("/api/leaderboard", (req,res) => {
  try {
    const limit = Math.min(100, Number(req.query.limit || 10));
    const user = req.query.user ? String(req.query.user).trim().toLowerCase() : null;

    // Prefer in-memory computed leaderboard for speed, but compute rank for player via helper
    // Use getLeaderboard for consistent result (it computes rank)
    const { leaderboard, player } = getLeaderboard(db, limit, user);

    return res.json({ ok: true, count: leaderboard.length, leaderboard, player });
  } catch (err) {
    console.error("/api/leaderboard error:", err);
    return res.status(500).json({ ok:false, error:String(err) });
  }
});

// Get profile info
app.get("/api/profile/:address", (req, res) => {
  try {
    const addr = String(req.params.address).trim().toLowerCase();
    const record = db.scores[addr] || null;
    if (!record || !record.profile_name) {
      return res.status(404).json({ ok: false, error: "No profile found" });
    }
    return res.json({
      ok: true,
      user_address: addr,
      profile_name: record.profile_name,
      level: record.level ?? 1
    });
  } catch (err) {
    console.error("/api/profile error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// Period info
app.get("/api/period", (req,res) => {
  try {
    const { periodIndex, periodStart, periodEnd } = computePeriod(Date.now(), DURATION_MS);
    const record = db.periods[periodIndex] || null;
    return res.json({ periodIndex, periodStart, periodEnd, durationMs:DURATION_MS, status:record?.status||"open", lastPayoutTx:record?.txHash||null, payouts:record?.payouts||null });
  } catch(err) { return res.status(500).json({ ok:false, error:String(err) }); }
});

// Process now (force)
app.post("/api/process-now", async (req,res) => {
  try {
    const ts = Date.now()-1000;
    const { periodIndex } = computePeriod(ts, DURATION_MS);
    await processPeriod(contract, db, periodIndex, TOP_N, HOUSE_FEE_BPS, { gasLimit:GAS_LIMIT, pool });
    return res.json({ ok:true, record: db.periods[periodIndex]||null });
  } catch(err) { return res.status(500).json({ ok:false, error:String(err) }); }
});

// Cron
cron.schedule(CRON_SCHEDULE, async () => {
  try {
    const { periodIndex } = computePeriod(Date.now()-1000, DURATION_MS);
    console.log("Cron processing period", periodIndex, new Date().toISOString());
    await processPeriod(contract, db, periodIndex, TOP_N, HOUSE_FEE_BPS, { gasLimit:GAS_LIMIT, pool });
  } catch(err){ console.error("Cron error:", err); }
}, { timezone:"UTC" });

// Start
app.listen(PORT, ()=>console.log(`Server listening on ${PORT}`));
