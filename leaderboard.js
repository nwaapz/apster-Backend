// leaderboard.js
import fs from "fs";
import path from "path";

// Atomic write to JSON file
export async function writeDBAtomicAsync(DB_FILE, data) {
  const tmp = `${DB_FILE}.tmp`;
  const dir = path.dirname(DB_FILE);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const text = JSON.stringify(data, null, 2);
  await fs.promises.writeFile(tmp, text, "utf8");
  await fs.promises.rename(tmp, DB_FILE);
}

// Read DB or return defaults
export function readDBSync(DB_FILE) {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const starter = { periods: {}, scores: {}, profileNames: {} };
      fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(starter, null, 2), "utf8");
      return starter;
    }
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    parsed.periods = parsed.periods || {};
    parsed.scores = parsed.scores || {};
    parsed.profileNames = parsed.profileNames || {};
    return parsed;
  } catch (e) {
    console.warn("readDBSync failed:", e.message);
    return { periods: {}, scores: {}, profileNames: {} };
  }
}

// Normalize profile name for uniqueness
export function normalizeProfileName(name) {
  return String(name || "").trim().toLowerCase();
}

// Compute current period based on timestamp
export function computePeriod(ts, DURATION_MS) {
  const periodIndex = Math.floor(ts / DURATION_MS);
  return { 
    periodIndex,
    periodStart: periodIndex * DURATION_MS,
    periodEnd: (periodIndex + 1) * DURATION_MS
  };
}

// Compute winners from contract
export async function computeWinnersFromOnchain(contract, TOP_N, HOUSE_FEE_BPS) {
  const players = await contract.getCurrentPlayers();
  if (!players || players.length === 0) return { winners: [], amounts: [], poolBalanceBN: "0" };

  const deposits = await Promise.all(players.map(async p => {
    const d = await contract.getPlayerDeposit(p);
    return { addr: p, deposit: BigInt(d?.toString() ?? String(d)) };
  }));

  deposits.sort((a,b) => (b.deposit - a.deposit > 0n ? 1 : b.deposit - a.deposit < 0n ? -1 : 0));

  const poolBalanceBN = BigInt((await contract.poolBalance()).toString());
  if (poolBalanceBN === 0n) return { winners: [], amounts: [], poolBalanceBN: "0" };

  const houseFeeTotal = (poolBalanceBN * BigInt(HOUSE_FEE_BPS)) / 10000n;
  const payoutPool = poolBalanceBN - houseFeeTotal;

  // Split percentages
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

  const w1pct = 50;
  const w2pct = 50;
  const house1 = (houseFeeTotal * BigInt(w1pct)) / 100n;
  const house2 = houseFeeTotal - house1;

  return { winners, amounts, house1: house1.toString(), house2: house2.toString(), poolBalanceBN: poolBalanceBN.toString() };
}

// Process period (pay winners, house, reset)
export async function processPeriod(contract, db, periodIndex, TOP_N, HOUSE_FEE_BPS, opts = {}) {
  db.periods = db.periods || {};
  const existing = db.periods[periodIndex];
  if (existing?.status === "processing" || existing?.status === "paid") return;

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
    const amounts = result.amounts.map(a => BigInt(a));

    const tx = await contract.payPlayers(winners, amounts, { ...(opts.gasLimit ? { gasLimit: opts.gasLimit } : {}) });
    await tx.wait(1);

    const h1 = BigInt(result.house1 || "0");
    const h2 = BigInt(result.house2 || "0");
    if (h1 > 0n || h2 > 0n) {
      const tx2 = await contract.payHouse(h1, h2);
      await tx2.wait(1);
    }

    if (typeof contract.resetPayments === "function") {
      const resetTx = await contract.resetPayments();
      if (resetTx?.wait) await resetTx.wait(1);
    }

    db.periods[periodIndex].status = "paid";
    db.periods[periodIndex].txHash = tx.hash;
    db.periods[periodIndex].payouts = winners.map((w,i) => ({ to: w, amount: amounts[i].toString() }));
    db.periods[periodIndex].updated_at = new Date().toISOString();
  } catch (err) {
    console.error("Error processing period:", err);
    db.periods[periodIndex].status = "failed";
    db.periods[periodIndex].error = err?.message || String(err);
    db.periods[periodIndex].updated_at = new Date().toISOString();
  }
}
