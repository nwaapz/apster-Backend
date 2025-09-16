// leaderboard.js
import { ethers } from "ethers";

/**
 * DB helper functions + on-chain logic for leaderboard
 *
 * Exports:
 *  - initDB(pool)
 *  - saveScore(pool, db, scoreObj)
 *  - saveProfileName(pool, db, normalized, owner_address)
 *  - savePeriod(pool, db, periodIndex, periodObj)
 *  - normalizeProfileName(name)
 *  - computePeriod(ts, DURATION_MS)
 *  - computeWinnersFromOnchain(contract, TOP_N, HOUSE_FEE_BPS)
 *  - processPeriod(contract, db, periodIndex, TOP_N, HOUSE_FEE_BPS, opts)
 *  - getLeaderboard(db, limit = 10, user = null)
 */

// ----------------------- DB init & helpers -----------------------
export async function initDB(pool) {
  // Create tables (safe). Include level column in DDL.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      user_address TEXT PRIMARY KEY,
      profile_name TEXT,
      email TEXT,
      highest_score BIGINT DEFAULT 0,
      last_score BIGINT DEFAULT 0,
      games_played INTEGER DEFAULT 0,
      level INTEGER DEFAULT 1,
      last_updated TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS profile_names (
      normalized_name TEXT PRIMARY KEY,
      owner_address TEXT REFERENCES scores(user_address)
    );
    CREATE TABLE IF NOT EXISTS periods (
      period_index BIGINT PRIMARY KEY,
      status TEXT,
      tx_hash TEXT,
      payouts JSONB,
      error TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      created_at TIMESTAMP,
      expires_at TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS admin_settings (
      k TEXT PRIMARY KEY,
      v JSONB
    );
  `);

  // Safe migration: ensure 'level' column exists (if older schema)
  await pool.query(`ALTER TABLE scores ADD COLUMN IF NOT EXISTS level INTEGER DEFAULT 1;`);

  const db = { scores: {}, profileNames: {}, periods: {} };

  // Load scores into in-memory cache
  const scoresRes = await pool.query(`SELECT * FROM scores`);
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

  // Load profile names
  const profileRes = await pool.query(`SELECT * FROM profile_names`);
  for (const r of profileRes.rows) {
    if (!r.normalized_name) continue;
    db.profileNames[r.normalized_name] = (r.owner_address || "").toLowerCase();
  }

  // Load periods
  const periodsRes = await pool.query(`SELECT * FROM periods`);
  for (const r of periodsRes.rows) {
    db.periods[String(r.period_index)] = {
      periodIndex: Number(r.period_index),
      status: r.status || null,
      txHash: r.tx_hash || null,
      payouts: r.payouts || null,
      error: r.error || null,
      updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString()
    };
  }

  return db;
}

export async function saveScore(pool, db, scoreObj) {
  const {
    user_address,
    profile_name = null,
    email = null,
    highest_score = 0,
    last_score = null,
    games_played = 0,
    level = 1,
    last_updated = new Date().toISOString()
  } = scoreObj;

  const userAddress = String(user_address).toLowerCase();

  await pool.query(
    `INSERT INTO scores(user_address, profile_name, email, highest_score, last_score, games_played, level, last_updated)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(user_address) DO UPDATE
     SET profile_name = EXCLUDED.profile_name,
         email = EXCLUDED.email,
         highest_score = EXCLUDED.highest_score,
         last_score = EXCLUDED.last_score,
         games_played = EXCLUDED.games_played,
         level = EXCLUDED.level,
         last_updated = EXCLUDED.last_updated`,
    [
      userAddress,
      profile_name,
      email,
      String(highest_score),
      last_score === null ? null : String(last_score),
      games_played,
      Number(level),
      last_updated
    ]
  );

  db.scores[userAddress] = {
    user_address: userAddress,
    profile_name,
    email,
    highest_score: Number(highest_score || 0),
    last_score: last_score === null ? null : Number(last_score),
    games_played: Number(games_played || 0),
    level: Number(level || 1),
    last_updated
  };
}

export async function saveProfileName(pool, db, normalized, owner_address) {
  await pool.query(
    `INSERT INTO profile_names(normalized_name, owner_address)
     VALUES($1,$2)
     ON CONFLICT(normalized_name) DO UPDATE SET owner_address = EXCLUDED.owner_address`,
    [normalized, owner_address]
  );
  db.profileNames[normalized] = owner_address.toLowerCase();
}

export async function savePeriod(pool, db, periodIndex, periodObj) {
  const payoutsJson = periodObj.payouts ? JSON.stringify(periodObj.payouts) : null;

  await pool.query(
    `INSERT INTO periods(period_index, status, tx_hash, payouts, error, updated_at)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(period_index) DO UPDATE
     SET status = EXCLUDED.status,
         tx_hash = EXCLUDED.tx_hash,
         payouts = EXCLUDED.payouts,
         error = EXCLUDED.error,
         updated_at = EXCLUDED.updated_at`,
    [
      String(periodIndex),
      periodObj.status || null,
      periodObj.txHash || null,
      payoutsJson,
      periodObj.error || null,
      periodObj.updated_at || new Date().toISOString()
    ]
  );

  db.periods[String(periodIndex)] = {
    periodIndex: Number(periodIndex),
    status: periodObj.status || null,
    txHash: periodObj.txHash || null,
    payouts: periodObj.payouts || null, // keep native array in memory
    error: periodObj.error || null,
    updated_at: periodObj.updated_at || new Date().toISOString()
  };
}


// ----------------------- Misc helpers -----------------------
export function normalizeProfileName(name) {
  return String(name || "").trim().toLowerCase();
}

// leaderboard.js
export function computePeriod(ts, DURATION_MS) {
  // Anchor to a known Friday 00:00 UTC
  const FRIDAY_0_UTC = Date.UTC(2025, 0, 3, 0, 0, 0); // Jan 3, 2025 is Friday
  const periodIndex = Math.floor((ts - FRIDAY_0_UTC) / DURATION_MS);
  return {
    periodIndex,
    periodStart: FRIDAY_0_UTC + periodIndex * DURATION_MS,
    periodEnd: FRIDAY_0_UTC + (periodIndex + 1) * DURATION_MS
  };
}


// ----------------------- Leaderboard helper -----------------------
/**
 * getLeaderboard(db, limit = 10, user = null)
 * - db: the in-memory db cache from initDB
 * - limit: number of top players to return
 * - user: optional user address (string) to include player's own record + rank
 *
 * Returns: { leaderboard: [...], player: { user_address, profile_name, score, level, rank|null } | null }
 */
export function getLeaderboard(db, limit = 10, user = null) {
  if (!db || !db.scores) return { leaderboard: [], player: null };

  const allPlayers = Object.values(db.scores || {}).slice();

  // sort descending by highest_score
  allPlayers.sort((a, b) => Number(b.highest_score || 0) - Number(a.highest_score || 0));

  const leaderboard = allPlayers.slice(0, limit).map((p, idx) => ({
    user_address: p.user_address,
    profile_name: p.profile_name || null,
    score: Number(p.highest_score || 0),
    level: Number(p.level ?? 1),
    rank: idx + 1
  }));

  let playerRecord = null;
  if (user) {
    const normalized = String(user).trim().toLowerCase();
    const p = db.scores[normalized];
    if (p) {
      // compute full rank across all players
      const rank = allPlayers.findIndex(x => x.user_address === normalized);
      playerRecord = {
        user_address: p.user_address,
        profile_name: p.profile_name || null,
        score: Number(p.highest_score || 0),
        level: Number(p.level ?? 1),
        rank: rank >= 0 ? rank + 1 : null
      };
    } else {
      playerRecord = null;
    }
  }

  return { leaderboard, player: playerRecord };
}

// ----------------------- On-chain computation -----------------------
export async function computeWinnersFromOnchain(contract, TOP_N, HOUSE_FEE_BPS) {
  const players = await contract.getCurrentPlayers();
  if (!players || players.length === 0) return { winners: [], amounts: [], poolBalanceBN: "0" };

  const deposits = await Promise.all(players.map(async p => {
    const d = await contract.getPlayerDeposit(p);
    // d may be BigNumber-like (ethers), convert to BigInt safely
    return { addr: p, deposit: BigInt(d?.toString() ?? "0") };
  }));

  // sort descending by deposit
  deposits.sort((a, b) => (b.deposit > a.deposit ? 1 : b.deposit < a.deposit ? -1 : 0));

  const poolBalanceBN = BigInt((await contract.poolBalance()).toString());
  if (poolBalanceBN === 0n) return { winners: [], amounts: [], poolBalanceBN: "0" };

  const houseFeeTotal = (poolBalanceBN * BigInt(HOUSE_FEE_BPS)) / 10000n;
  const payoutPool = poolBalanceBN - houseFeeTotal;

  let split;
  if (TOP_N === 1) split = [100];
  else if (TOP_N === 2) split = [60, 40];
  else if (TOP_N === 3) split = [50, 30, 20];
  else {
    const base = Math.floor(100 / TOP_N);
    split = Array.from({ length: TOP_N }, () => base);
    let rem = 100 - base * TOP_N;
    for (let i = 0; rem > 0 && i < split.length; i++, rem--) split[i] += 1;
  }

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

  const w1pct = 50, w2pct = 50;
  const house1 = (houseFeeTotal * BigInt(w1pct)) / 100n;
  const house2 = houseFeeTotal - house1;

  return { winners, amounts, house1: house1.toString(), house2: house2.toString(), poolBalanceBN: poolBalanceBN.toString() };
}

// ----------------------- Period processing (on-chain payouts) -----------------------
export async function processPeriod(contract, db, periodIndex, TOP_N, HOUSE_FEE_BPS, opts = {}) {
  const pool = opts.pool;
  if (!db.periods) db.periods = {};
  const existing = db.periods[periodIndex];
  if (existing?.status === "processing" || existing?.status === "paid")
    {

      console.log(`Period ${periodIndex} is already being processed or paid.`);
      return;
    } 

  const nowIso = new Date().toISOString();
  db.periods[periodIndex] = { status: "processing", updated_at: nowIso };
  if (pool) await savePeriod(pool, db, periodIndex, db.periods[periodIndex]);

  try {
    const result = await computeWinnersFromOnchain(contract, TOP_N, HOUSE_FEE_BPS);
    if (!result.winners || result.winners.length === 0) {
      const periodObj = { status: "paid", payouts: [], updated_at: new Date().toISOString() };
      db.periods[periodIndex] = periodObj;
      if (pool) await savePeriod(pool, db, periodIndex, periodObj);
      return;
    }

    const winners = result.winners;
    const amounts = result.amounts.map(a => BigInt(a));

    const tx = await contract.payPlayers(winners, amounts, { ...(opts.gasLimit ? { gasLimit: opts.gasLimit } : {}) });
    if (tx?.wait) await tx.wait(1);

    const h1 = BigInt(result.house1 || "0");
    const h2 = BigInt(result.house2 || "0");
    if (h1 > 0n || h2 > 0n) {
      const tx2 = await contract.payHouse(h1, h2);
      if (tx2?.wait) await tx2.wait(1);
    }

    if (typeof contract.resetPayments === "function") {
      const resetTx = await contract.resetPayments();
      if (resetTx?.wait) await resetTx.wait(1);
    }

    const periodObj = {
      status: "paid",
      txHash: tx.hash || null,
      payouts: winners.map((w, i) => ({ to: w, amount: amounts[i].toString() })),
      updated_at: new Date().toISOString()
    };
    db.periods[periodIndex] = periodObj;
    if (pool) await savePeriod(pool, db, periodIndex, periodObj);
  } catch (err) {
    console.error("Error processing period:", err);
    const periodObj = { status: "failed", error: err?.message || String(err), updated_at: new Date().toISOString() };
    db.periods[periodIndex] = periodObj;
    if (pool) await savePeriod(pool, db, periodIndex, periodObj);
  }
}

// ----------------------- Exports -----------------------
export default {
  initDB,
  saveScore,
  saveProfileName,
  savePeriod,
  normalizeProfileName,
  computePeriod,
  computeWinnersFromOnchain,
  processPeriod,
  getLeaderboard
};
