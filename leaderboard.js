// leaderboard.js
import { ethers } from "ethers";

/**
 * DB helper functions + on-chain logic
 */

export async function initDB(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      user_address TEXT PRIMARY KEY,
      profile_name TEXT,
      email TEXT,
      highest_score BIGINT DEFAULT 0,
      last_score BIGINT DEFAULT 0,
      games_played INTEGER DEFAULT 0,
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

  const db = { scores: {}, profileNames: {}, periods: {} };

  const scoresRes = await pool.query(`SELECT * FROM scores`);
  for (const r of scoresRes.rows) {
    db.scores[r.user_address.toLowerCase()] = {
      user_address: r.user_address.toLowerCase(),
      profile_name: r.profile_name || null,
      email: r.email || null,
      highest_score: Number(r.highest_score ?? 0),
      last_score: r.last_score === null ? null : Number(r.last_score),
      games_played: Number(r.games_played ?? 0),
      last_updated: r.last_updated ? new Date(r.last_updated).toISOString() : new Date().toISOString()
    };
  }

  const profileRes = await pool.query(`SELECT * FROM profile_names`);
  for (const r of profileRes.rows) {
    db.profileNames[r.normalized_name] = (r.owner_address || "").toLowerCase();
  }

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
    last_updated = new Date().toISOString()
  } = scoreObj;

  const userAddress = String(user_address).toLowerCase();

  await pool.query(
    `INSERT INTO scores(user_address, profile_name, email, highest_score, last_score, games_played, last_updated)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(user_address) DO UPDATE
     SET profile_name = EXCLUDED.profile_name,
         email = EXCLUDED.email,
         highest_score = EXCLUDED.highest_score,
         last_score = EXCLUDED.last_score,
         games_played = EXCLUDED.games_played,
         last_updated = EXCLUDED.last_updated`,
    [userAddress, profile_name, email, String(highest_score), last_score === null ? null : String(last_score), games_played, last_updated]
  );

  db.scores[userAddress] = {
    user_address: userAddress,
    profile_name,
    email,
    highest_score: Number(highest_score || 0),
    last_score: last_score === null ? null : Number(last_score),
    games_played: Number(games_played || 0),
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
  await pool.query(
    `INSERT INTO periods(period_index, status, tx_hash, payouts, error, updated_at)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(period_index) DO UPDATE
     SET status = EXCLUDED.status,
         tx_hash = EXCLUDED.tx_hash,
         payouts = EXCLUDED.payouts,
         error = EXCLUDED.error,
         updated_at = EXCLUDED.updated_at`,
    [String(periodIndex), periodObj.status || null, periodObj.txHash || null, periodObj.payouts ? periodObj.payouts : null, periodObj.error || null, periodObj.updated_at || new Date().toISOString()]
  );

  db.periods[String(periodIndex)] = {
    periodIndex: Number(periodIndex),
    status: periodObj.status || null,
    txHash: periodObj.txHash || null,
    payouts: periodObj.payouts || null,
    error: periodObj.error || null,
    updated_at: periodObj.updated_at || new Date().toISOString()
  };
}

export function normalizeProfileName(name) {
  return String(name || "").trim().toLowerCase();
}

export function computePeriod(ts, DURATION_MS) {
  const periodIndex = Math.floor(ts / DURATION_MS);
  return {
    periodIndex,
    periodStart: periodIndex * DURATION_MS,
    periodEnd: (periodIndex + 1) * DURATION_MS
  };
}

export async function computeWinnersFromOnchain(contract, TOP_N, HOUSE_FEE_BPS) {
  const players = await contract.getCurrentPlayers();
  if (!players || players.length === 0) return { winners: [], amounts: [], poolBalanceBN: "0" };

  const deposits = await Promise.all(players.map(async p => {
    const d = await contract.getPlayerDeposit(p);
    return { addr: p, deposit: BigInt(d?.toString() ?? "0") };
  }));

  deposits.sort((a,b) => (b.deposit - a.deposit > 0n ? 1 : b.deposit - a.deposit < 0n ? -1 : 0));

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

export async function processPeriod(contract, db, periodIndex, TOP_N, HOUSE_FEE_BPS, opts = {}) {
  const pool = opts.pool;
  if (!db.periods) db.periods = {};
  const existing = db.periods[periodIndex];
  if (existing?.status === "processing" || existing?.status === "paid") return;

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
      payouts: winners.map((w,i) => ({ to: w, amount: amounts[i].toString() })),
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
