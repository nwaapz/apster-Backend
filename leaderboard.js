// leaderboard.js
import fs from "fs";
import path from "path";

// Read DB file synchronously at startup. If missing or invalid, return defaults.
export function readDBSync(DB_FILE) {
  try {
    if (!fs.existsSync(DB_FILE)) {
      // ensure directory exists
      const dir = path.dirname(DB_FILE);
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const starter = { periods: {}, scores: {} };
      // write starter atomically
      writeDBAtomicSync(DB_FILE, starter);
      return starter;
    }
    const raw = fs.readFileSync(DB_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.warn("readDBSync: failed to read/parse DB file, using defaults:", e.message);
    return { periods: {}, scores: {} };
  }
}

// Atomic write: write to temp file then rename
export function writeDBAtomicSync(DB_FILE, data) {
  const tmp = `${DB_FILE}.tmp`;
  const dir = path.dirname(DB_FILE);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const text = JSON.stringify(data, null, 2);
  // write temp file synchronously
  fs.writeFileSync(tmp, text, { encoding: "utf8" });
  // rename is atomic on most OSes
  fs.renameSync(tmp, DB_FILE);
}

// Compute current period based on timestamp
export function computePeriod(ts, DURATION_MS) {
  const periodIndex = Math.floor(ts / DURATION_MS);
  const periodStart = periodIndex * DURATION_MS;
  const periodEnd = periodStart + DURATION_MS;
  return { periodIndex, periodStart, periodEnd };
}

// Compute winners from on-chain contract
// Returns winners[], amounts[] (strings), house1, house2, poolBalanceBN (string)
export async function computeWinnersFromOnchain(contract, TOP_N, HOUSE_FEE_BPS) {
  // contract should expose getCurrentPlayers(), getPlayerDeposit(address), poolBalance()
  const players = await contract.getCurrentPlayers();
  if (!players || players.length === 0) return { winners: [], amounts: [], poolBalanceBN: "0" };

  const deposits = await Promise.all(
    players.map(async (p) => {
      const d = await contract.getPlayerDeposit(p);
      // make safe BigInt conversion
      const depositBN = BigInt(d?.toString?.() ?? String(d));
      return { addr: p, deposit: depositBN };
    })
  );

  // sort descending by deposit
  deposits.sort((a, b) => (a.deposit < b.deposit ? 1 : a.deposit > b.deposit ? -1 : 0));

  const poolBalanceBN = BigInt((await contract.poolBalance()).toString());
  if (poolBalanceBN === 0n) return { winners: [], amounts: [], poolBalanceBN: "0" };

  const houseFeeTotal = (poolBalanceBN * BigInt(HOUSE_FEE_BPS)) / 10000n;
  const payoutPool = poolBalanceBN - houseFeeTotal;

  let split;
  if (TOP_N === 1) split = [100];
  else if (TOP_N === 2) split = [60, 40];
  else if (TOP_N === 3) split = [50, 30, 20];
  else {
    // evenly distribute remaining rounding down
    const base = Math.floor(100 / TOP_N);
    split = Array.from({ length: TOP_N }, () => base);
    // adjust remainder to first entries
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

  // house split — configurable if you want; default 50/50
  const w1pct = 50;
  const w2pct = 50;
  const house1 = (houseFeeTotal * BigInt(w1pct)) / 100n;
  const house2 = houseFeeTotal - house1;

  return {
    winners,
    amounts,
    house1: house1.toString(),
    house2: house2.toString(),
    poolBalanceBN: poolBalanceBN.toString()
  };
}

// Process period (pay winners, house, reset).
// contract: ethers.Contract
// db: in-memory database object (will be mutated)
// periodIndex: number
// TOP_N, HOUSE_FEE_BPS: numbers
// opts: { gasLimit }
export async function processPeriod(contract, db, periodIndex, TOP_N, HOUSE_FEE_BPS, opts = {}) {
  db.periods = db.periods || {};
  const existing = db.periods[periodIndex];
  // avoid double-processing
  if (existing?.status === "processing" || existing?.status === "paid") {
    // no-op
    return;
  }

  // Mark processing synchronously (prevents concurrent calls in same process)
  db.periods[periodIndex] = { status: "processing", updated_at: new Date().toISOString() };

  try {
    const result = await computeWinnersFromOnchain(contract, TOP_N, HOUSE_FEE_BPS);
    if (!result.winners || result.winners.length === 0) {
      db.periods[periodIndex].status = "paid";
      db.periods[periodIndex].payouts = [];
      db.periods[periodIndex].updated_at = new Date().toISOString();
      return;
    }

    const winners = result.winners;
    // amounts as BigInt (ethers v6 accepts BigInt for numeric params)
    const amounts = result.amounts.map((a) => BigInt(a));

    // Pay winners
    const tx = await contract.payPlayers(winners, amounts, { ...(opts.gasLimit ? { gasLimit: opts.gasLimit } : {}) });
    await tx.wait(1);

    // Pay house portions (if any)
    const h1 = BigInt(result.house1 || "0");
    const h2 = BigInt(result.house2 || "0");
    if (h1 > 0n || h2 > 0n) {
      const tx2 = await contract.payHouse(h1, h2);
      await tx2.wait(1);
    }

    // Reset on-chain payments if required by your contract
    if (typeof contract.resetPayments === "function") {
      const resetTx = await contract.resetPayments();
      if (resetTx?.wait) await resetTx.wait(1);
    }

    db.periods[periodIndex].status = "paid";
    db.periods[periodIndex].txHash = tx.hash;
    db.periods[periodIndex].payouts = winners.map((w, i) => ({ to: w, amount: amounts[i].toString() }));
    db.periods[periodIndex].updated_at = new Date().toISOString();
  } catch (err) {
    console.error("Error processing period:", err);
    db.periods[periodIndex].status = "failed";
    db.periods[periodIndex].error = typeof err === "object" ? (err.message || String(err)) : String(err);
    db.periods[periodIndex].updated_at = new Date().toISOString();
  }
}
