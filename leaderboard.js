// leaderboard.js
import { ethers } from "ethers";

/**
 * DB helper functions + off-chain leaderboard logic
 *
 * Exports:
 *  - initDB(pool)
 *  - saveScore(pool, db, scoreObj)
 *  - saveProfileName(pool, db, normalized, owner_address)
 *  - savePeriod(pool, db, periodIndex, periodObj)
 *  - normalizeProfileName(name)
 *  - computePeriod(ts, DURATION_MS)
 *  - computeWinnersFromOffchain(db, TOP_N, HOUSE_FEE_BPS)
 *  - processPeriod(db, periodIndex, TOP_N, HOUSE_FEE_BPS, opts)
 *  - getLeaderboard(db, limit = 10, user = null)
 */

// ----------------------- DB init & helpers -----------------------
export async function initDB(pool) {
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

export function computePeriod(ts, DURATION_MS) {
  const FRIDAY_0_UTC = Date.UTC(2025, 0, 3, 0, 0, 0);
  const periodIndex = Math.floor((ts - FRIDAY_0_UTC) / DURATION_MS);
  return {
    periodIndex,
    periodStart: FRIDAY_0_UTC + periodIndex * DURATION_MS,
    periodEnd: FRIDAY_0_UTC + (periodIndex + 1) * DURATION_MS
  };
}

// ----------------------- Leaderboard helper -----------------------
// ----------------------- Leaderboard helper -----------------------
export function getLeaderboard(db, limit = 10, user = null) {
  if (!db || !db.scores) return { leaderboard: [], player: null };

  // Build an array of all players and normalize score values
  const allPlayersRaw = Object.values(db.scores || {}).slice();

  // Filter out players with non-positive scores (<= 0)
  const scoredPlayers = allPlayersRaw
    .map(p => ({
      ...p,
      highest_score: Number(p.highest_score || 0)
    }))
    .filter(p => Number(p.highest_score) > 0);

  // Sort descending by highest_score
  scoredPlayers.sort((a, b) => Number(b.highest_score) - Number(a.highest_score));

  // Build leaderboard limited to requested size
  const leaderboard = scoredPlayers.slice(0, limit).map((p, idx) => ({
    user_address: p.user_address,
    profile_name: p.profile_name || null,
    score: Number(p.highest_score || 0),
    level: Number(p.level ?? 1),
    rank: idx + 1
  }));

  // Build player record (if requested). Player may be excluded from leaderboard if score <= 0,
  // but we still return their score and null rank in that case.
  let playerRecord = null;
  if (user) {
    const normalized = String(user).trim().toLowerCase();
    const p = db.scores[normalized];
    if (p) {
      const score = Number(p.highest_score || 0);

      // If player's score > 0 compute rank among scoredPlayers, otherwise rank is null
      let rank = null;
      if (score > 0) {
        const idx = scoredPlayers.findIndex(x => x.user_address === normalized);
        rank = idx >= 0 ? idx + 1 : null;
      }

      playerRecord = {
        user_address: p.user_address,
        profile_name: p.profile_name || null,
        score,
        level: Number(p.level ?? 1),
        rank
      };
    } else {
      playerRecord = null;
    }
  }

  return { leaderboard, player: playerRecord };
}


// ----------------------- Off-chain computation -----------------------

// Compute winners using off-chain leaderboard, but read poolBalance on-chain to determine amounts
export async function computeWinnersFromOffchain(contract, db) {
  // Read pool balance from contract
  let poolBalanceBN = 0n;
  try {
    const pb = await contract.poolBalance();
    poolBalanceBN = typeof pb === "bigint" ? pb : BigInt(pb?.toString?.() ?? "0");
  } catch (err) {
    console.error("Cannot read poolBalance:", err);
    return { winners: [], amounts: [], house: "0", poolBalanceBN: "0" };
  }

  if (poolBalanceBN === 0n) return { winners: [], amounts: [], house: "0", poolBalanceBN: "0" };

  // Get top players
  const allScores = Object.values(db.scores || {});
  if (!allScores.length) return { winners: [], amounts: [], house: "0", poolBalanceBN: poolBalanceBN.toString() };

  allScores.sort((a, b) => (b.highest_score || 0) - (a.highest_score || 0));
  const topPlayers = allScores.slice(0, 10); // max 10 players

  // Compute house fee
  const houseFeeBN = (poolBalanceBN * 30n) / 100n; // 30%
  const payoutPoolBN = poolBalanceBN - houseFeeBN; // 70% to top players

  // Distribution percentages
  const distributionPercents: bigint[] = [48n, 29n, 9n]; // first 3 players
  const remainingPlayers = topPlayers.length - 3;
  if (remainingPlayers > 0) {
    for (let i = 0; i < remainingPlayers; i++) distributionPercents.push(2n); // 2% each
  }

  // Only take as many percentages as players exist
  const percents = distributionPercents.slice(0, topPlayers.length);

  // Compute total percent
  const totalPercent = percents.reduce((a, b) => a + b, 0n);

  // Compute payouts
  const winners: string[] = [];
  const amounts: bigint[] = [];
  let allocated = 0n;

  for (let i = 0; i < topPlayers.length; i++) {
    const p = topPlayers[i];
    winners.push(p.user_address);

    const share = (payoutPoolBN * percents[i]) / totalPercent;
    amounts.push(share);
    allocated += share;
  }

  // Assign any remainder to first player to ensure exact payout
  const remainder = payoutPoolBN - allocated;
  if (remainder > 0n) amounts[0] += remainder;

  return {
    winners,
    amounts: amounts.map(a => a.toString()), // convert to string for on-chain
    house: houseFeeBN.toString(),
    poolBalanceBN: poolBalanceBN.toString()
  };
}


// ----------------------- Period processing (off-chain payouts) -----------------------
export async function processPeriod(contract, db, periodIndex, TOP_N, HOUSE_FEE_BPS, opts = {}) {
  const pool = opts.pool;
  if (!db.periods) db.periods = {};
  const existing = db.periods[periodIndex];
  if (existing?.status === "processing" || existing?.status === "paid") {
    console.log(`Period ${periodIndex} is already being processed or paid.`);
    return;
  }

  const nowIso = new Date().toISOString();
  db.periods[periodIndex] = { status: "processing", updated_at: nowIso };
  if (pool) await savePeriod(pool, db, periodIndex, db.periods[periodIndex]);

  try {
    // Compute winners using *off-chain* leaderboard but read poolBalance on-chain inside function
    const result = await computeWinnersFromOffchain(contract, db, TOP_N, HOUSE_FEE_BPS);

    if (!result.winners || result.winners.length === 0) {
      const periodObj = { status: "paid", payouts: [], updated_at: new Date().toISOString() };
      db.periods[periodIndex] = periodObj;
      if (pool) await savePeriod(pool, db, periodIndex, periodObj);
      return;
    }

    const winners = result.winners;
    const amounts = result.amounts.map(a => BigInt(a)); // BigInt values for contract call
    // call on-chain contract to pay players (must be owner-signer contract)
    let tx = null;
    try {
      tx = await contract.payPlayers(winners, amounts, { ...(opts.gasLimit ? { gasLimit: opts.gasLimit } : {}) });
      if (tx?.wait) await tx.wait(1);
    } catch (err) {
      // If payPlayers failed, log and mark failed
      console.error("payPlayers failed:", err);
      throw err;
    }

    // Pay house - only if house amounts > 0
    const h1 = BigInt(result.house1 || "0");
    const h2 = BigInt(result.house2 || "0");
    if ((h1 > 0n || h2 > 0n) && typeof contract.payHouse === "function") {
      try {
        const tx2 = await contract.payHouse(h1, h2);
        if (tx2?.wait) await tx2.wait(1);
      } catch (err) {
        console.error("payHouse failed:", err);
        // you can choose to continue or throw; throwing marks the period failed
        throw err;
      }
    }

    // Reset payments on-chain if function exists (owner only)
    if (typeof contract.resetPayments === "function") {
      try {
        const resetTx = await contract.resetPayments();
        if (resetTx?.wait) await resetTx.wait(1);
      } catch (err) {
        console.error("resetPayments() failed:", err);
        // Not fatal — log and continue
      }
    }

    // Save period result (use tx.hash)
    const periodObj = {
      status: "paid",
      txHash: tx?.hash || null,
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
  computeWinnersFromOffchain,
  processPeriod,
  getLeaderboard
};
