// leaderboard.js
import fs from "fs";
import { ethers } from "ethers";

export function readDBSync(DB_FILE) {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (e) {
    return { periods: {} };
  }
}

export function writeDBSync(DB_FILE, data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Compute current period based on timestamp
export function computePeriod(ts, DURATION_MS) {
  const periodIndex = Math.floor(ts / DURATION_MS);
  const periodStart = periodIndex * DURATION_MS;
  const periodEnd = periodStart + DURATION_MS;
  return { periodIndex, periodStart, periodEnd };
}

// Compute winners from on-chain contract
export async function computeWinnersFromOnchain(contract, TOP_N, HOUSE_FEE_BPS) {
  const players = await contract.getCurrentPlayers();
  if (!players || players.length === 0) return { winners: [], amounts: [], poolBalanceBN: "0" };

  const deposits = await Promise.all(players.map(async (p) => {
    const d = await contract.getPlayerDeposit(p);
    return { addr: p, deposit: BigInt(d.toString()) };
  }));

  deposits.sort((a, b) => (b.deposit > a.deposit ? 1 : b.deposit < a.deposit ? -1 : 0));

  const poolBalanceBN = BigInt((await contract.poolBalance()).toString());
  if (poolBalanceBN === 0n) return { winners: [], amounts: [], poolBalanceBN: "0" };

  const houseFeeTotal = (poolBalanceBN * BigInt(HOUSE_FEE_BPS)) / 10000n;
  const payoutPool = poolBalanceBN - houseFeeTotal;

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

  const w1pct = 50; // or read from env
  const w2pct = 50;
  const house1 = (houseFeeTotal * BigInt(w1pct)) / 100n;
  const house2 = houseFeeTotal - house1;

  return {
    winners,
    amounts,
    house1: house1.toString(),
    house2: house2.toString(),
    poolBalanceBN: poolBalanceBN.toString(),
  };
}

// Process period (pay winners, house, reset)
export async function processPeriod(contract, DB_FILE, periodIndex, TOP_N, HOUSE_FEE_BPS) {
  const db = readDBSync(DB_FILE);
  db.periods = db.periods || {};
  const existing = db.periods[periodIndex];
  if (existing?.status === "processing" || existing?.status === "paid") return;

  db.periods[periodIndex] = { status: "processing", updated_at: new Date().toISOString() };
  writeDBSync(DB_FILE, db);

  try {
    const result = await computeWinnersFromOnchain(contract, TOP_N, HOUSE_FEE_BPS);
    if (!result.winners || result.winners.length === 0) {
      db.periods[periodIndex].status = "paid";
      db.periods[periodIndex].payouts = [];
      db.periods[periodIndex].updated_at = new Date().toISOString();
      writeDBSync(DB_FILE, db);
      return;
    }

    const winners = result.winners;
    const amounts = result.amounts.map(a => BigInt(a));

    const tx = await contract.payPlayers(winners, amounts, { gasLimit: 2_000_000 });
    await tx.wait(1);

    const h1 = BigInt(result.house1 || 0);
    const h2 = BigInt(result.house2 || 0);
    if (h1 > 0n || h2 > 0n) {
      const tx2 = await contract.payHouse(h1, h2);
      await tx2.wait(1);
    }

    const resetTx = await contract.resetPayments();
    await resetTx.wait(1);

    db.periods[periodIndex].status = "paid";
    db.periods[periodIndex].txHash = tx.hash;
    db.periods[periodIndex].payouts = winners.map((w, i) => ({ to: w, amount: amounts[i].toString() }));
    db.periods[periodIndex].updated_at = new Date().toISOString();
    writeDBSync(DB_FILE, db);
  } catch (err) {
    console.error("Error processing period:", err);
    db.periods[periodIndex].status = "failed";
    db.periods[periodIndex].error = String(err);
    db.periods[periodIndex].updated_at = new Date().toISOString();
    writeDBSync(DB_FILE, db);
  }
}
