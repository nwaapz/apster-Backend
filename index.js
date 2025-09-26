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
import { keccak256, toUtf8Bytes } from "ethers";
// ===== session + deterministic board helpers =====
import crypto from "crypto";
import stringify from 'json-stable-stringify';

// in-memory sessions (persist to DB in prod)
const SESSIONS = new Map(); // sessionId -> { user, seed, board, createdAt, used }
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 20); // 20 min default

function createSessionId() { return crypto.randomBytes(12).toString('hex'); }
function nowMs() { return Date.now(); }

// simple seeded RNG (mulberry32) - keep deterministic across Node & C# ports
function mulberry32(seed) {
  let t = seed >>> 0;
  return function() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ensureVerifiedPlaysTable.js  (paste into index.js or import from a util file)
async function ensureVerifiedPlaysTable(pool) {
  const sql = `
  -- table
CREATE TABLE IF NOT EXISTS verified_plays (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_address TEXT NOT NULL,
  replay_hash TEXT NOT NULL,
  score INTEGER NOT NULL,
  kills INTEGER,
  survival_ticks INTEGER,
  raw_replay JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_verified_plays_replay_hash
  ON verified_plays (replay_hash);
  `;
  try {
    await pool.query(sql);
    console.log("✅ verified_plays table ensured (exists or created).");
  } catch (err) {
    console.error("❌ Failed to ensure verified_plays table:", err);
    throw err;
  }
}



// simple admin check using x-admin-secret header
async function isAdminAuthed(req) {
  const secret = req.headers["x-admin-secret"] || req.headers["X-Admin-Secret"];
  return secret && secret === ADMIN_SECRET;
}


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
const readOnlyContract = new ethers.Contract(CONTRACT_ADDRESS, contractJson.abi, provider);




// --- TEST FUNCTION TO CHECK CONTRACT ACCESS ---
async function testContractAccess() {
  try {
    const owner = await readOnlyContract.owner();
    console.log("✅ Contract Owner:", owner);

    const poolBalance = await readOnlyContract.poolBalance();
    console.log("✅ Pool Balance:", poolBalance.toString());

    const player = "0x9ACB85e48eE65018D14913eD4bEFdCd3517680ad";
    const hasPaid = await readOnlyContract.hasPaid(player);
    console.log(`✅ Has Paid (${player}):`, hasPaid);

    const deposit = await readOnlyContract.getPlayerDeposit(player);
    console.log(`✅ Deposit (${player}):`, deposit.toString());

    const currentPlayers = await readOnlyContract.getCurrentPlayers();
    console.log("✅ Current Players:", currentPlayers);

    console.log("✅ Contract access test passed!");
  } catch (err) {
    console.error("❌ Contract access test failed:", err);
  }
}


// Run the test before starting Express
await testContractAccess();


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

try {
  await ensureVerifiedPlaysTable(pool);
} catch (err) {
  console.error("Failed DB pre-checks (ensureVerifiedPlaysTable):", err);
  process.exit(1);
}

// --- Express ---
const app = express();


app.use(cors());
app.use(express.json({ limit: '3mb' }));

// Register admin routes, provide pool to adminRoutes


// Register admin routes, provide pool and contract instance to adminRoutes
registerAdminRoutes(app, db, {
  pool,
  adminSecret: ADMIN_SECRET,
  contract: readOnlyContract // <-- read-only for dashboard
});




// Root
app.get("/", (req,res) => res.send("✅ Backend running (Postgres)!"));



// Start a session - server returns the authoritative board and seed
app.post("/api/start-session", async (req, res) => {
  try {
    const sessionId = ethers.hexlify(ethers.randomBytes(16)); // unique
    const expiresAt = Date.now() + 22 * 60 * 1000; // 10 min
    SESSIONS.set(sessionId, { used: false, expiresAt });
    res.json({ sessionId, expiresAt });
  } catch (err) {
    console.error("start-session error:", err);
    res.status(500).json({ error: "could not start session" });
  }
});


// Submit replay - server verifies deterministically
// Submit replay - server verifies deterministically and updates leaderboard just like /submit-score
// Submit replay - server verifies deterministically and updates leaderboard just like /submit-score
app.post("/api/submit-replay", async (req, res) => {
  try {
    const { sessionId, userAddress, replay, profile_name, email, level } = req.body;

    // --- Validate input payload ---
    if (!sessionId || !replay) {
      console.warn(`[ReplaySubmit] Missing sessionId or replay. Payload:`, req.body);
      return res.status(400).json({ error: "missing sessionId or replay" });
    }

    // --- Session validation ---
    const s = SESSIONS.get(sessionId);
    if (!s) {
      console.warn(`[ReplaySubmit] Session not found: ${sessionId}`);
      return res.status(400).json({ error: "session not found" });
    }
    if (s.used) {
      console.warn(`[ReplaySubmit] Session already used: ${sessionId}`);
      return res.status(400).json({ error: "session already used" });
    }
    const now = Date.now();
    if (now > s.expiresAt) {
      const diff = now - s.expiresAt;
      console.warn(`[ReplaySubmit] Session expired ${diff}ms ago. SessionId=${sessionId}`);
      return res.status(400).json({ error: `session expired ${diff}ms ago` });
    }

    // --- Replay shape validation ---
    if (!Array.isArray(replay)) {
      console.warn(`[ReplaySubmit] Replay not array. SessionId=${sessionId}`);
      return res.status(400).json({ error: "replay must be an array" });
    }
    const MAX_ENTRIES = 5000;
    if (replay.length === 0 || replay.length > MAX_ENTRIES) {
      console.warn(`[ReplaySubmit] Replay length invalid (${replay.length}). SessionId=${sessionId}`);
      return res.status(400).json({ error: `replay must have 1..${MAX_ENTRIES} entries` });
    }

    // --- Replay entries validation ---
    let lastTime = -1;
    let monotonic = true;
    const scores = [];
    for (let i = 0; i < replay.length; i++) {
      const ev = replay[i];
      if (!ev || typeof ev !== "object") {
        console.warn(`[ReplaySubmit] Invalid entry at index ${i}:`, ev);
        return res.status(400).json({ error: `invalid entry at index ${i}` });
      }

      const t = Number(ev.time);
      const sc = Number(ev.score);
      if (!Number.isFinite(t) || t < 0 || !Number.isFinite(sc) || sc < 0) {
        console.warn(`[ReplaySubmit] Invalid time/score at index ${i}. time=${ev.time}, score=${ev.score}`);
        return res.status(400).json({ error: `invalid time/score at index ${i}` });
      }

      scores.push(Math.floor(sc));
      if (t < lastTime) monotonic = false;
      lastTime = t;
    }

    // --- Canonicalize & hash replay ---
    const canonical = stringify(replay);
    const rHash = keccak256(toUtf8Bytes(canonical));

    // --- Compute final score ---
    const lastEntryScore = scores[scores.length - 1];
    const maxScore = Math.max(...scores);
    const serverScore = monotonic ? lastEntryScore : maxScore;
    const serverSurvival = lastTime;

    console.log(`[ReplaySubmit] Session=${sessionId}, User=${userAddress}, FinalScore=${serverScore}, Entries=${replay.length}, Monotonic=${monotonic}`);

    // --- Duplicate replay check ---
    const dupCheck = await pool.query(
      "SELECT id FROM verified_plays WHERE replay_hash = $1",
      [rHash]
    );
    if (dupCheck.rows.length) {
      console.warn(`[ReplaySubmit] Duplicate replay detected. Hash=${rHash}`);
      return res.status(409).json({ error: "replay already submitted", replayHash: rHash });
    }

    // --- Save replay in DB ---
    await pool.query(
      `INSERT INTO verified_plays 
        (session_id, user_address, replay_hash, score, kills, survival_ticks, raw_replay, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
      [
        sessionId,
        (userAddress || "unknown").toString().trim().toLowerCase(),
        rHash,
        serverScore,
        null, // kills not tracked yet
        serverSurvival,
        canonical
      ]
    );

    // --- Mark session as used ---
    s.used = true;
    SESSIONS.delete(sessionId);
    console.log(`[ReplaySubmit] Session ${sessionId} marked used & deleted`);

    // --- Update in-memory leaderboard ---
    const addr = String(userAddress || "unknown").trim().toLowerCase();
    const intScore = Math.floor(Number(serverScore) || 0);
    const intLevel = Number.isFinite(Number(level))
      ? Math.max(1, Math.floor(Number(level)))
      : (db.scores?.[addr]?.level || 1);

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
    if (intScore > Number(db.scores[addr].highest_score || 0)) {
      db.scores[addr].highest_score = intScore;
    }
    db.scores[addr].last_updated = new Date().toISOString();

    await saveScore(pool, db, db.scores[addr]);
    console.log(`[ReplaySubmit] Leaderboard updated. User=${addr}, Score=${intScore}, Level=${intLevel}`);

    return res.json({
      ok: true,
      replayHash: rHash,
      saved: db.scores[addr],
      message: monotonic
        ? "accepted"
        : "accepted (non-monotonic times; validated using max score)"
    });
  } catch (err) {
    console.error("[ReplaySubmit] Unexpected error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});







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

app.post("/admin/wipe-leaderboard", async (req, res) => {
  if (!(await isAdminAuthed(req))) return res.status(403).json({ ok: false, error: "Not authorized" });

  try {
    // Reset scores in a transaction (preserve profile_names table and owner_address)
    await pool.query("BEGIN");

    // Reset numeric/score fields for all players
    await pool.query(`
      UPDATE scores
      SET highest_score = 0,
          last_score = NULL,
          games_played = 0,
          level = 1,
          last_updated = NOW()
    `);

    await pool.query("COMMIT");

    // Reload in-memory cache (scores)
    const scoresRes = await pool.query(`SELECT * FROM scores`);
    db.scores = {};
    for (const r of scoresRes.rows) {
      const addr = (r.user_address || "").toLowerCase();
      if (!addr) continue;
      db.scores[addr] = {
        user_address: addr,
        profile_name: r.profile_name || null,
        email: r.email || null,
        highest_score: Number(r.highest_score ?? 0),
        last_score: r.last_score === null ? null : Number(r.last_score),
        games_played: Number(r.games_played ?? 0),
        level: Number(r.level ?? 1),
        last_updated: r.last_updated ? new Date(r.last_updated).toISOString() : new Date().toISOString()
      };
    }

    // Reload profile names mapping (left intact in DB)
    const profileRes = await pool.query(`SELECT normalized_name, owner_address FROM profile_names`);
    db.profileNames = {};
    for (const r of profileRes.rows) {
      db.profileNames[r.normalized_name] = r.owner_address ? r.owner_address.toLowerCase() : null;
    }

    return res.json({ ok: true, message: "Leaderboard cleared (scores reset). Player profiles and owner addresses preserved." });
  } catch (err) {
    try { await pool.query("ROLLBACK"); } catch (e) {}
    console.error("wipe-leaderboard error:", err.stack || err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});


// In your index.js (development only)
app.post("/admin/wipe-periods", async (req, res) => {
  // Simple admin check
  if (!(req.headers["x-admin-secret"] === process.env.ADMIN_SECRET)) {
    return res.status(403).json({ ok: false, error: "Not authorized" });
  }

  try {
    // Delete all periods from DB and clear in-memory cache
    await pool.query("DELETE FROM periods");
    if (db.periods) db.periods = {};
    return res.json({ ok: true, message: "All periods wiped (DB + memory)" });
  } catch (err) {
    console.error("wipe-periods error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});



// Process now (force)
app.post("/api/process-now", async (req,res) => {
  try {
    const ts = Date.now()-1000;
    const { periodIndex } = computePeriod(ts, DURATION_MS);
    console.log("Manual processing of period", periodIndex, new Date().toISOString());
    console.log(TOP_N, HOUSE_FEE_BPS, GAS_LIMIT);
    await processPeriod(contract, db, periodIndex, TOP_N, HOUSE_FEE_BPS, { gasLimit:GAS_LIMIT, pool });
    return res.json({ ok:true, record: db.periods[periodIndex]||null });
  } catch(err) { return res.status(500).json({ ok:false, error:String(err) }); }
});

// Cron
const job = cron.schedule(CRON_SCHEDULE, async () => {
  try {
    const { periodIndex } = computePeriod(Date.now()-1000, DURATION_MS);
    console.log("Cron processing period", periodIndex, new Date().toISOString());
    await processPeriod(contract, db, periodIndex, TOP_N, HOUSE_FEE_BPS, { gasLimit: GAS_LIMIT, pool });
  } catch(err){
    console.error("Cron error:", err);
  }
}, { timezone: "UTC", scheduled: false });
job.stop();
// Start
app.listen(PORT, ()=>console.log(`Server listening on ${PORT}`));
