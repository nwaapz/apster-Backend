// index.js
import express from "express";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import { ethers } from "ethers";
import {
  processPeriod,
  computePeriod,
  readDBSync,
  writeDBAtomicSync
} from "./leaderboard.js";

dotenv.config();

// ------------------- Config -------------------
const PORT = Number(process.env.PORT || 3001);
const DURATION_MS = Number(process.env.DURATION_MS) || 1000 * 60 * 60; // default 1 hour
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 * * * *";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const RPC_URL = process.env.RPC_URL;
let PRIVATE_KEY = process.env.PRIVATE_KEY;
const HOUSE_FEE_BPS = Number(process.env.HOUSE_FEE_BPS || 100);
const TOP_N = Number(process.env.TOP_N || 3);
const DB_FILE = path.resolve(process.env.DB_FILE || "./periods.json");
const FLUSH_INTERVAL_MS = Number(process.env.FLUSH_INTERVAL_MS || 20_000);
const GAS_LIMIT = Number(process.env.GAS_LIMIT || 2_000_000);

// ------------------- Env Checks -------------------
if (!CONTRACT_ADDRESS || !RPC_URL || !PRIVATE_KEY) {
  console.error("Please set CONTRACT_ADDRESS, RPC_URL, and PRIVATE_KEY in .env");
  process.exit(1);
}
if (!PRIVATE_KEY.startsWith("0x")) PRIVATE_KEY = "0x" + PRIVATE_KEY;

// ------------------- Contract -------------------
const ABI_PATH = path.resolve("./abi/WagerPoolSingleEntry.json");
if (!fs.existsSync(ABI_PATH)) {
  console.error("ABI file missing at", ABI_PATH);
  process.exit(1);
}
const contractJson = JSON.parse(fs.readFileSync(ABI_PATH, "utf8"));
const provider = new ethers.JsonRpcProvider(RPC_URL);
const ownerWallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, contractJson.abi, ownerWallet);

// ------------------- In-memory DB -------------------
let db = readDBSync(DB_FILE);
db.scores = db.scores || {};
db.periods = db.periods || {};
db.profileNames = db.profileNames || {}; // normalized_name -> addr

let flushing = false;
function tryFlushSync() {
  if (flushing) return;
  flushing = true;
  try {
    writeDBAtomicSync(DB_FILE, db);
    console.log(`💾 DB flushed to disk (${new Date().toISOString()})`);
  } catch (err) {
    console.error("❌ Failed to flush DB:", err);
  } finally {
    flushing = false;
  }
}
const flushInterval = setInterval(tryFlushSync, FLUSH_INTERVAL_MS);

// graceful shutdown
function gracefulShutdown(signal) {
  console.log(`\n📛 Received ${signal}. Flushing DB and exiting...`);
  clearInterval(flushInterval);
  tryFlushSync();
  setTimeout(() => process.exit(0), 250);
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// ------------------- Express -------------------
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send("✅ Backend is running!"));

// Submit score (memory-only)
app.post("/api/submit-score", (req, res) => {
  try {
    const { user, email, score, profile_name } = req.body;
    if (!user || score === undefined || score === null) {
      return res.status(400).json({ ok: false, error: "Missing user or score" });
    }

    const addr = String(user).trim().toLowerCase();
    if (!addr) return res.status(400).json({ ok: false, error: "Invalid user" });

    const intScore = Math.floor(Number(score) || 0);

    db.scores = db.scores || {};
    const existing = db.scores[addr];

    // Ensure skeleton
    if (!existing) {
      db.scores[addr] = {
        user_address: addr,
        email: null,
        profile_name: null,
        highest_score: 0,
        games_played: 0,
        last_score: null,
        last_updated: new Date().toISOString()
      };
    }

    // Optional: allow updating profile_name through submit-score only if provided and passes validation.
    if (profile_name !== undefined && profile_name !== null) {
      const raw = String(profile_name).trim();
      const MAX_LEN = 32;
      const allowed = /^[\p{L}\p{N}\s\-_]+$/u;
      if (raw.length === 0 || raw.length > MAX_LEN) {
        return res.status(400).json({ ok: false, error: `profile_name must be 1-${MAX_LEN} characters` });
      }
      if (!allowed.test(raw)) {
        return res.status(400).json({ ok: false, error: "profile_name contains invalid characters" });
      }
      // Note: we do NOT change uniqueness/index here — prefer using /api/update-profile for uniqueness-enforced changes.
      db.scores[addr].profile_name = raw;
    }

    // update email if provided
    if (email) db.scores[addr].email = String(email).trim();

    // update gameplay stats
    db.scores[addr].last_score = intScore;
    db.scores[addr].games_played = (db.scores[addr].games_played || 0) + 1;

    if (intScore > (db.scores[addr].highest_score || 0)) {
      db.scores[addr].highest_score = intScore;
    }

    db.scores[addr].last_updated = new Date().toISOString();

    return res.json({ ok: true, saved: db.scores[addr] });
  } catch (err) {
    console.error("submit-score error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// Leaderboard endpoint - returns top N by highest_score
app.get("/api/leaderboard", (req, res) => {
  try {
    const limit = Math.min(100, Number(req.query.limit || 10));
    const scores = db.scores || {};
    const top = Object.values(scores)
      .sort((a, b) => (b.highest_score || 0) - (a.highest_score || 0))
      .slice(0, limit);
    return res.json({ ok: true, count: top.length, leaderboard: top });
  } catch (err) {
    console.error("leaderboard error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// Get current period
app.get("/api/period", (req, res) => {
  try {
    const now = Date.now();
    const p = computePeriod(now, DURATION_MS);
    const record = db.periods[p.periodIndex] || null;
    return res.json({
      periodIndex: p.periodIndex,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      durationMs: DURATION_MS,
      status: record?.status || "open",
      lastPayoutTx: record?.txHash || null,
      payouts: record?.payouts || null
    });
  } catch (err) {
    console.error("/api/period error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// Force process current period
app.post("/api/process-now", async (req, res) => {
  try {
    const ts = Date.now() - 1000;
    const { periodIndex } = computePeriod(ts, DURATION_MS);
    await processPeriod(contract, db, periodIndex, TOP_N, HOUSE_FEE_BPS, { gasLimit: GAS_LIMIT });
    return res.json({ ok: true, record: db.periods[periodIndex] || null });
  } catch (err) {
    console.error("process-now error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// Update profile name endpoint (uniqueness enforced)
app.post("/api/update-profile", (req, res) => {
  try {
    const { user, profile_name } = req.body;

    if (!user) return res.status(400).json({ ok: false, error: "Missing user (wallet address)" });
    if (profile_name === undefined || profile_name === null) {
      return res.status(400).json({ ok: false, error: "Missing profile_name" });
    }

    const addr = String(user).trim().toLowerCase();
    if (!addr) return res.status(400).json({ ok: false, error: "Invalid user" });

    const raw = String(profile_name).trim();
    const MAX_LEN = 32;
    const allowed = /^[\p{L}\p{N}\s\-_]+$/u;

    if (raw.length === 0 || raw.length > MAX_LEN) {
      return res.status(400).json({ ok: false, error: `profile_name must be 1-${MAX_LEN} characters` });
    }
    if (!allowed.test(raw)) {
      return res.status(400).json({ ok: false, error: "profile_name contains invalid characters" });
    }

    db.profileNames = db.profileNames || {};
    db.scores = db.scores || {};

    const normalized = raw.toLowerCase();
    const existingOwner = db.profileNames[normalized];

    // If name is taken by another address => conflict
    if (existingOwner && existingOwner !== addr) {
      return res.status(409).json({ ok: false, error: "profile_name already exists" });
    }

    // If already owned by this addr => idempotent success (update display name case)
    if (existingOwner === addr) {
      db.scores[addr] = db.scores[addr] || {
        user_address: addr,
        email: null,
        profile_name: raw,
        highest_score: 0,
        games_played: 0,
        last_updated: new Date().toISOString()
      };
      db.scores[addr].profile_name = raw;
      db.scores[addr].last_updated = new Date().toISOString();
      return res.json({ ok: true, message: "profile_name already set for this user", saved: db.scores[addr] });
    }

    // Name is free — remove previous name of this user (if any)
    const prevName = db.scores[addr]?.profile_name;
    if (prevName) {
      const prevNorm = String(prevName).toLowerCase();
      if (db.profileNames[prevNorm] === addr) delete db.profileNames[prevNorm];
    }

    // Ensure user skeleton then set name and index
    db.scores[addr] = db.scores[addr] || {
      user_address: addr,
      email: null,
      profile_name: null,
      highest_score: 0,
      games_played: 0,
      last_updated: new Date().toISOString()
    };

    db.scores[addr].profile_name = raw;
    db.scores[addr].last_updated = new Date().toISOString();
    db.profileNames[normalized] = addr;

    return res.json({ ok: true, message: "profile_name set", saved: db.scores[addr] });
  } catch (err) {
    console.error("/api/update-profile error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// Admin endpoint: force flush to disk
app.post("/api/flush-db", (req, res) => {
  try {
    tryFlushSync();
    return res.json({ ok: true, message: "Flush triggered" });
  } catch (err) {
    console.error("/api/flush-db error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// ------------------- Cron -------------------
cron.schedule(
  CRON_SCHEDULE,
  async () => {
    try {
      const ts = Date.now() - 1000;
      const { periodIndex } = computePeriod(ts, DURATION_MS);
      console.log("Cron triggered for period", periodIndex, new Date().toISOString());
      await processPeriod(contract, db, periodIndex, TOP_N, HOUSE_FEE_BPS, { gasLimit: GAS_LIMIT });
    } catch (err) {
      console.error("Cron error:", err);
    }
  },
  { timezone: "UTC" }
);

// ------------------- Start Server -------------------
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT} (DURATION_MS=${DURATION_MS}, CRON='${CRON_SCHEDULE}', flush=${FLUSH_INTERVAL_MS}ms)`);
});
