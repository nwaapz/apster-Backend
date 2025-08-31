// index.js
import express from "express";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import { ethers } from "ethers";
import pkg from "pg";
import { processPeriod, computePeriod } from "./leaderboard.js";

const { Pool } = pkg;
dotenv.config();

// ------------------- Config -------------------
const PORT = process.env.PORT || 3001;
const DURATION_MS = Number(process.env.DURATION_MS) || 1000 * 60 * 60;
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 * * * *";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const RPC_URL = process.env.RPC_URL;
let PRIVATE_KEY = process.env.PRIVATE_KEY;
const HOUSE_FEE_BPS = Number(process.env.HOUSE_FEE_BPS || 100);
const TOP_N = Number(process.env.TOP_N || 3);
const DB_FILE = path.resolve("./periods.json");

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

// ------------------- Postgres -------------------
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pool.connect().then(c => c.release()).catch(console.error);
}

// ------------------- Express -------------------
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send("✅ Backend is running!"));

// Submit score endpoint
app.post("/api/submit-score", async (req, res) => {
  if (!pool) return res.json({ ok: true, warning: "DB not configured; submission logged only." });

  try {
    const { user, email, score } = req.body;
    if (!user || !score) return res.status(400).json({ ok: false, error: "Missing user or score" });

    const intScore = Math.floor(Number(score));
    const upsertQuery = `
      INSERT INTO player_scores (user_address, email, highest_score)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_address)
      DO UPDATE SET
        highest_score = GREATEST(player_scores.highest_score, EXCLUDED.highest_score),
        email = COALESCE(EXCLUDED.email, player_scores.email),
        last_updated = NOW()
      RETURNING *;
    `;
    const result = await pool.query(upsertQuery, [user.trim().toLowerCase(), email?.trim() || null, intScore]);
    res.json({ ok: true, saved: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Create DB table
app.get("/create-db", async (req, res) => {
  if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL not configured" });
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS player_scores (
      id SERIAL PRIMARY KEY,
      user_address VARCHAR(42) NOT NULL,
      email VARCHAR(255),
      highest_score INT NOT NULL,
      last_updated TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_address)
    );
  `;
  await pool.query(createTableSQL);
  res.json({ ok: true, message: "Table created or already exists." });
});

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// Get current period
app.get("/api/period", (req, res) => {
  const now = Date.now();
  const p = computePeriod(now, DURATION_MS);
  let db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch { db = { periods: {} }; }
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
});

// Force process current period
app.post("/api/process-now", async (req, res) => {
  const ts = Date.now() - 1000;
  const { periodIndex } = computePeriod(ts, DURATION_MS);
  await processPeriod(contract, DB_FILE, periodIndex, TOP_N, HOUSE_FEE_BPS);
  const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  res.json({ ok: true, record: db.periods[periodIndex] || null });
});

// ------------------- Cron -------------------
cron.schedule(CRON_SCHEDULE, async () => {
  try {
    const ts = Date.now() - 1000;
    const { periodIndex } = computePeriod(ts, DURATION_MS);
    console.log("Cron triggered for period", periodIndex, new Date().toISOString());
    await processPeriod(contract, DB_FILE, periodIndex, TOP_N, HOUSE_FEE_BPS);
  } catch (err) {
    console.error("Cron error:", err);
  }
}, { timezone: "UTC" });

// ------------------- Start Server -------------------
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT} (DURATION_MS=${DURATION_MS}, CRON='${CRON_SCHEDULE}')`);
});
