// index.js
import express from "express";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import { ethers } from "ethers";
import pkg from "pg";
const { Pool } = pkg;

dotenv.config();

const PORT = process.env.PORT || 3001;
const DURATION_MS = Number(process.env.DURATION_MS) || 1000 * 60 * 60;
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 * * * *";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const RPC_URL = process.env.RPC_URL;
let PRIVATE_KEY = process.env.PRIVATE_KEY;
const HOUSE_FEE_BPS = Number(process.env.HOUSE_FEE_BPS || 100);
const TOP_N = Number(process.env.TOP_N || 3);

// basic env check (keep it as you had it)
if (!CONTRACT_ADDRESS || !RPC_URL || !PRIVATE_KEY) {
  console.error("Please set CONTRACT_ADDRESS, RPC_URL and PRIVATE_KEY in .env");
  process.exit(1);
}

// normalize private key (add 0x if missing)
if (!PRIVATE_KEY.startsWith("0x")) PRIVATE_KEY = "0x" + PRIVATE_KEY;

// Read ABI synchronously
const ABI_PATH = path.resolve("./abi/WagerPoolSingleEntry.json");
if (!fs.existsSync(ABI_PATH)) {
  console.error("ABI file missing at", ABI_PATH);
  process.exit(1);
}
const contractJson = JSON.parse(fs.readFileSync(ABI_PATH, "utf8"));

// provider, signer, contract
const provider = new ethers.JsonRpcProvider(RPC_URL);
const ownerWallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, contractJson.abi, ownerWallet);

// Simple JSON DB file for dev (keeps your existing behaviour)
const DB_FILE = path.resolve("./periods.json");
function readDBSync() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (e) {
    return { periods: {} };
  }
}
function writeDBSync(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// compute period
function computePeriod(ts = Date.now()) {
  const periodIndex = Math.floor(ts / DURATION_MS);
  const periodStart = periodIndex * DURATION_MS;
  const periodEnd = periodStart + DURATION_MS;
  return { periodIndex, periodStart, periodEnd };
}

// ---------- Postgres pool (optional) ----------
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Render requires TLS
  });

  pool
    .connect()
    .then((client) => {
      client.release();
      console.log("Connected to Postgres");
    })
    .catch((err) => {
      console.error("Postgres connection error:", err);
      // keep pool as-is; queries will fail if attempted
    });
} else {
  console.log("DATABASE_URL not set — DB routes are disabled (will just log).");
}

// Express server
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("✅ Backend is running!");
});

// POST /api/submit-score
// Body: { user: string, email?: string|null, score: number }
app.post("/api/submit-score", async (req, res) => {
  try {
    const { user, email, score } = req.body;

    // Basic validation
    if (!user || typeof user !== "string") {
      return res.status(400).json({ ok: false, error: "Missing/invalid user address" });
    }
    const parsedScore = Number(score);
    if (!Number.isFinite(parsedScore)) {
      return res.status(400).json({ ok: false, error: "Missing/invalid score" });
    }

    const timestamp = new Date().toISOString();
    console.log("Submit score received:", { user, email: email ?? null, score: parsedScore, timestamp });

    // If no DB configured, return success but log
    if (!pool) {
      return res.json({ ok: true, warning: "DB not configured; submission logged only." });
    }

    // Upsert to keep only highest score per user_address
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
    const values = [user, email || null, parsedScore];

    const result = await pool.query(upsertQuery, values);
    return res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error("Submit score error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// Route to create the DB table (call once)
app.get("/create-db", async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).send({ ok: false, error: "DATABASE_URL not configured" });
    }

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
    res.send({ ok: true, message: "Table created or already exists." });
  } catch (err) {
    console.error("Error creating table:", err);
    res.status(500).send({ ok: false, error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/api/period", (req, res) => {
  try {
    const now = Date.now();
    const p = computePeriod(now);
    const db = readDBSync();
    const record = db.periods[p.periodIndex] || null;
    res.json({
      periodIndex: p.periodIndex,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      durationMs: DURATION_MS,
      status: record?.status || "open",
      lastPayoutTx: record?.txHash || null,
      payouts: record?.payouts || null,
    });
  } catch (err) {
    console.error("/api/period error", err);
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/process-now", async (req, res) => {
  try {
    const ts = Date.now() - 1000;
    const { periodIndex } = computePeriod(ts);
    await processPeriod(periodIndex);
    const db = readDBSync();
    res.json({ ok: true, record: db.periods[periodIndex] || null });
  } catch (err) {
    console.error("process-now error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// compute winners using on-chain players (dev default). Replace with your logic if needed.
async function computeWinnersFromOnchain(periodIndex) {
  console.log("Fetching players from on-chain contract...");
  const players = await contract.getCurrentPlayers();
  if (!players || players.length === 0) {
    return { winners: [], amounts: [], poolBalanceBN: "0" };
  }

  const deposits = await Promise.all(players.map(async (p) => {
    try {
      const d = await contract.getPlayerDeposit(p);
      return { addr: p, deposit: BigInt(d.toString()) };
    } catch (err) {
      console.warn("Failed reading deposit for", p, err);
      return { addr: p, deposit: 0n };
    }
  }));

  deposits.sort((a, b) => (b.deposit > a.deposit ? 1 : b.deposit < a.deposit ? -1 : 0));

  const poolBalanceBN = BigInt((await contract.poolBalance()).toString());
  console.log("On-chain pool balance (wei):", poolBalanceBN.toString());
  if (poolBalanceBN === 0n) return { winners: [], amounts: [], poolBalanceBN: "0" };

  const houseFeeTotal = (poolBalanceBN * BigInt(HOUSE_FEE_BPS)) / 10000n;
  const payoutPool = poolBalanceBN - houseFeeTotal;

  // simple split rules
  let split;
  if (TOP_N === 1) split = [100];
  else if (TOP_N === 2) split = [60, 40];
  else if (TOP_N === 3) split = [50, 30, 20];
  else split = Array.from({ length: TOP_N }, () => Math.floor(100 / TOP_N));

  const winners = [];
  const amounts = [];
  for (let i = 0; i < Math.min(TOP_N, deposits.length); i++) {
    const pct = BigInt(split[i] ?? 0);
    const amount = (payoutPool * pct) / 100n;
    if (amount > 0n) {
      winners.push(deposits[i].addr);
      amounts.push(amount.toString());
    }
  }

  const w1pct = Number(process.env.HOUSE_SPLIT_W1 ?? 50);
  const w2pct = Number(process.env.HOUSE_SPLIT_W2 ?? 50);
  const w1pctBig = BigInt(w1pct);
  const house1 = (houseFeeTotal * w1pctBig) / 100n;
  const house2 = houseFeeTotal - house1;

  return {
    winners,
    amounts,
    house1: house1.toString(),
    house2: house2.toString(),
    poolBalanceBN: poolBalanceBN.toString(),
  };
}

async function processPeriod(periodIndex) {
  console.log("Processing period", periodIndex);
  const db = readDBSync();
  db.periods = db.periods || {};

  const existing = db.periods[periodIndex];
  if (existing?.status === "processing" || existing?.status === "paid") {
    console.log("Already processed/processing; skipping.");
    return;
  }

  db.periods[periodIndex] = { status: "processing", updated_at: new Date().toISOString() };
  writeDBSync(db);

  try {
    const result = await computeWinnersFromOnchain(periodIndex);
    if (!result.winners || result.winners.length === 0) {
      console.log("No winners this period; marking paid (no payouts).");
      db.periods[periodIndex].status = "paid";
      db.periods[periodIndex].payouts = [];
      db.periods[periodIndex].updated_at = new Date().toISOString();
      writeDBSync(db);
      return;
    }

    const winners = result.winners;
    const amounts = result.amounts.map(a => BigInt(a));

    const sumPayouts = amounts.reduce((acc, v) => acc + BigInt(v), 0n);
    const poolBalanceBN = BigInt(result.poolBalanceBN || (await contract.poolBalance()).toString());
    const houseFeeTotal = (poolBalanceBN * BigInt(HOUSE_FEE_BPS)) / 10000n;
    if (sumPayouts + houseFeeTotal > poolBalanceBN) {
      throw new Error("Calculated payouts exceed pool balance");
    }

    console.log("Calling payPlayers:", winners.length);
    const tx = await contract.payPlayers(winners, amounts, { gasLimit: 2_000_000 });
    console.log("payPlayers tx sent:", tx.hash);
    await tx.wait(1);
    console.log("payPlayers confirmed", tx.hash);

    if (BigInt(result.house1 || 0) > 0n || BigInt(result.house2 || 0) > 0n) {
      const h1 = BigInt(result.house1 || 0);
      const h2 = BigInt(result.house2 || 0);
      console.log("Calling payHouse:", h1.toString(), h2.toString());
      const tx2 = await contract.payHouse(h1, h2);
      console.log("payHouse tx sent:", tx2.hash);
      await tx2.wait(1);
      console.log("payHouse confirmed", tx2.hash);
    }

    const resetTx = await contract.resetPayments();
    console.log("resetPayments tx sent:", resetTx.hash);
    await resetTx.wait(1);
    console.log("resetPayments confirmed", resetTx.hash);

    db.periods[periodIndex].status = "paid";
    db.periods[periodIndex].txHash = tx.hash;
    db.periods[periodIndex].payouts = winners.map((w, i) => ({ to: w, amount: amounts[i].toString() }));
    db.periods[periodIndex].updated_at = new Date().toISOString();
    writeDBSync(db);

    console.log("Period processed:", periodIndex);
  } catch (err) {
    console.error("Error processing period:", err);
    db.periods[periodIndex].status = "failed";
    db.periods[periodIndex].error = String(err);
    db.periods[periodIndex].updated_at = new Date().toISOString();
    writeDBSync(db);
  }
}

// Cron schedule - runs at CRON_SCHEDULE (UTC)
cron.schedule(
  CRON_SCHEDULE,
  async () => {
    try {
      const ts = Date.now() - 1000;
      const { periodIndex } = computePeriod(ts);
      console.log("Cron triggered for period", periodIndex, new Date().toISOString());
      await processPeriod(periodIndex);
    } catch (err) {
      console.error("Cron error:", err);
    }
  },
  { timezone: "UTC" }
);

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT} (DURATION_MS=${DURATION_MS}, CRON='${CRON_SCHEDULE}')`);
});
