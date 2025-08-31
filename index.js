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
const DURATION_MS = Number(process.env.DURATION_MS) || 1000 * 60 * 60; // 1 hour default
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
// Ensure DB file exists (readDBSync returns defaults if missing)
let db = readDBSync(DB_FILE);
db.scores = db.scores || {};
db.periods = db.periods || {};

// Flag to indicate a flush is in progress (prevents concurrent disk writes)
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

// Periodic flush
const flushInterval = setInterval(tryFlushSync, FLUSH_INTERVAL_MS);

// Flush on shutdown (SIGINT / SIGTERM)
async function gracefulShutdown(signal) {
  console.log(`\n📛 Received ${signal}. Flushing DB and exiting...`);
  clearInterval(flushInterval);
  tryFlushSync();
  // small delay to ensure logs show up
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
    const { user, email, score } = req.body;
    if (!user || score === undefined || score === null) {
      return res.status(400).json({ ok: false, error: "Missing user or score" });
    }

    const addr = String(user).trim().toLowerCase();
    const intScore = Math.floor(Number(score) || 0);

    db.scores = db.scores || {};
    const existing = db.scores[addr];

    if (!existing || intScore > existing.highest_score) {
      db.scores[addr] = {
        user_address: addr,
        email: email?.trim() || null,
        highest_score: intScore,
        last_updated: new Date().toISOString()
      };
      // we don't write to disk here; periodic flush will persist
    }

    res.json({ ok: true, saved: db.scores[addr] });
  } catch (err) {
    console.error("submit-score error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Leaderboard endpoint - returns top N by score
app.get("/api/leaderboard", (req, res) => {
  try {
    const limit = Math.min(100, Number(req.query.limit || 10)); // cap to 100
    const scores = db.scores || {};

    const top = Object.values(scores)
      .sort((a, b) => b.highest_score - a.highest_score)
      .slice(0, limit);

    res.json({ ok: true, count: top.length, leaderboard: top });
  } catch (err) {
    console.error("leaderboard error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Get current period
app.get("/api/period", (req, res) => {
  try {
    const now = Date.now();
    const p = computePeriod(now, DURATION_MS);
    const record = db.periods[p.periodIndex] || null;

    res.json({
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
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Force process current period
app.post("/api/process-now", async (req, res) => {
  try {
    const ts = Date.now() - 1000;
    const { periodIndex } = computePeriod(ts, DURATION_MS);
    // processPeriod will mutate db in-memory
    await processPeriod(contract, db, periodIndex, TOP_N, HOUSE_FEE_BPS, { gasLimit: GAS_LIMIT });
    res.json({ ok: true, record: db.periods[periodIndex] || null });
  } catch (err) {
    console.error("process-now error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Admin endpoint: force flush to disk right now
app.post("/api/flush-db", (req, res) => {
  try {
    tryFlushSync();
    res.json({ ok: true, message: "Flush triggered" });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
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
