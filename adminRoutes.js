// adminRoutes.js
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { ethers } from "ethers";


export default function registerAdminRoutes(app, db, opts = {}) {
  const ADMIN_SECRET = opts.adminSecret ?? null;
  const pool = opts.pool;
  const SESSION_TTL_MS = opts.sessionTtlMs ?? 60 * 60 * 1000; // 1 hour

  if (!pool) throw new Error("registerAdminRoutes requires opts.pool (pg Pool)");

  // --- Helper DB functions for admin settings & sessions ---
  async function loadAdminSettings() {
    const r = await pool.query(`SELECT v FROM admin_settings WHERE k = 'passwordHash' LIMIT 1`);
    if (r.rowCount === 0) return { passwordHash: null };
    const v = r.rows[0].v;
    return { passwordHash: v?.hash ?? null };
  }

  async function saveAdminSettings(adminData) {
    // adminData = { passwordHash: '...' }
    const v = { hash: adminData.passwordHash || null };
    await pool.query(`
      INSERT INTO admin_settings(k, v) VALUES('passwordHash', $1)
      ON CONFLICT(k) DO UPDATE SET v = EXCLUDED.v
    `, [v]);
  }

  async function createAdminSession(token, ttlMs) {
    const created = new Date();
    const expires = new Date(Date.now() + ttlMs);
    await pool.query(
      `INSERT INTO admin_sessions(token, created_at, expires_at) VALUES($1,$2,$3)
       ON CONFLICT(token) DO UPDATE SET created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at`,
      [token, created.toISOString(), expires.toISOString()]
    );
  }

  async function getAdminSession(token) {
    if (!token) return null;
    // Remove expired sessions first (optional)
    await pool.query(`DELETE FROM admin_sessions WHERE expires_at < NOW()`);
    const r = await pool.query(`SELECT token, created_at, expires_at FROM admin_sessions WHERE token = $1 LIMIT 1`, [token]);
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return { token: row.token, createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() };
  }

  async function deleteAdminSession(token) {
    if (!token) return;
    await pool.query(`DELETE FROM admin_sessions WHERE token = $1`, [token]);
  }

  // Cookie helper
  function getCookie(req, name) {
    const header = req.headers?.cookie;
    if (!header) return null;
    const pairs = header.split(";").map(s => s.trim());
    for (const p of pairs) {
      const [k, ...rest] = p.split("=");
      if (k === name) return rest.join("=");
    }
    return null;
  }

  async function isAdminAuthed(req) {
    // ADMIN_SECRET bypass - header or query param
    if (ADMIN_SECRET) {
      const header = req.headers["x-admin-secret"];
      const q = req.query?.secret;
      if (header === ADMIN_SECRET || q === ADMIN_SECRET) return true;
    }

    // session cookie
    const token = getCookie(req, "admin_auth");
    if (!token) return false;
    const s = await getAdminSession(token);
    if (!s) return false;
    // check expiry
    if (new Date(s.expiresAt).getTime() < Date.now()) {
      await deleteAdminSession(token);
      return false;
    }
    return true;
  }

  function htmlEscape(v) {
    if (v === undefined || v === null) return "";
    return String(v)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function buildTable(headers, rows) {
    let html = '<table class="table table-sm table-striped table-bordered"><thead class="table-dark"><tr>';
    for (const h of headers) html += `<th>${htmlEscape(h)}</th>`;
    html += "</tr></thead><tbody>";
    for (const row of rows) {
      html += "<tr>";
      for (const h of headers) {
        const v = row[h] === undefined ? "" : row[h];
        html += `<td><pre style="margin:0;white-space:pre-wrap">${htmlEscape(v)}</pre></td>`;
      }
      html += "</tr>";
    }
    html += "</tbody></table>";
    return html;
  }

  // Read small body helper (no body-parser)
  async function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }


  async function getContractData(contract) {
  try {
    const balance = await contract.provider.getBalance(contract.address);

    // Assuming your contract has a method like `getCurrentPlayers()`
    const currentPlayers = await contract.getCurrentPlayers();

    // And a mapping `playerPaid(address) -> uint` or similar
    const playerPayments = {};
    for (const addr of currentPlayers) {
      try {
        const paid = await contract.hasPaid(addr); // adjust to your contract method
        playerPayments[addr] = ethers.utils.formatEther(paid);
      } catch (err) {
        console.error("Error fetching payment for", addr, err);
        playerPayments[addr] = "Error";
      }
    }

    return {
      balance: ethers.utils.formatEther(balance),
      playerPayments
    };
  } catch (err) {
    console.error("getContractData error:", err);
    return { balance: "Error", playerPayments: {} };
  }
}


  // --- Routes ---
  app.get("/admin/login", async (req, res) => {
    if (await isAdminAuthed(req)) return res.redirect("/admin/db-view");
    const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Admin Login</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
<style>body{padding:20px;max-width:700px;margin:auto}</style>
</head>
<body>
  <h3>Admin Login</h3>
  <form method="POST" action="/admin/login">
    <div class="mb-3">
      <label class="form-label">Password</label>
      <input name="password" class="form-control" type="password" required />
    </div>
    <div class="mb-3">
      <button class="btn btn-primary" type="submit">Login</button>
      <a class="btn btn-outline-secondary" href="/admin/db-view">Back</a>
    </div>
    <p class="small text-muted">You can also send the ADMIN_SECRET header (x-admin-secret) or ?secret= in query if configured.</p>
  </form>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });

  app.post("/admin/login", async (req, res) => {
    try {
      const adminSettings = await loadAdminSettings();

      // ADMIN_SECRET bypass
      if (ADMIN_SECRET) {
        const header = req.headers["x-admin-secret"];
        const q = req.query?.secret;
        if (header === ADMIN_SECRET || q === ADMIN_SECRET) {
          const token = crypto.randomBytes(24).toString("hex");
          await createAdminSession(token, SESSION_TTL_MS);
          const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
          res.setHeader("Set-Cookie", `admin_auth=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS/1000)}${secure ? "; Secure" : ""}`);
          return res.redirect("/admin/db-view");
        }
      }

      const raw = await readBody(req);
      let password = null;
      if (raw.startsWith("password=") || raw.includes("&")) {
        const params = new URLSearchParams(raw);
        password = params.get("password");
      } else {
        try { const j = JSON.parse(raw); password = j.password; } catch {}
      }
      if (!password) return res.status(400).send("Missing password");

      if (!adminSettings.passwordHash) {
        return res.status(400).send("No admin password set. Use /admin/set-password or configure ADMIN_SECRET.");
      }

      const ok = bcrypt.compareSync(String(password), adminSettings.passwordHash);
      if (!ok) return res.status(403).send("Invalid password");

      const token = crypto.randomBytes(24).toString("hex");
      await createAdminSession(token, SESSION_TTL_MS);
      const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
      res.setHeader("Set-Cookie", `admin_auth=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS/1000)}${secure ? "; Secure" : ""}`);
      return res.redirect("/admin/db-view");
    } catch (err) {
      console.error("/admin/login error:", err);
      return res.status(500).send("Server error");
    }
  });

  app.get("/admin/set-password", async (req, res) => {
    const adminSettings = await loadAdminSettings();
    const adminExists = !!adminSettings.passwordHash;
    if (adminExists && !(await isAdminAuthed(req))) return res.redirect("/admin/login");

    const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Set Admin Password</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
<style>body{padding:20px;max-width:700px;margin:auto}</style>
</head>
<body>
  <h3>${adminExists ? "Change" : "Set"} Admin Password</h3>
  <form method="POST" action="/admin/set-password">
    ${adminExists ? `
    <div class="mb-3">
      <label class="form-label">Current Password</label>
      <input name="currentPassword" class="form-control" type="password" required />
    </div>
    ` : ''}
    <div class="mb-3">
      <label class="form-label">New Password</label>
      <input name="newPassword" class="form-control" type="password" required minlength="6" />
    </div>
    <div class="mb-3">
      <button class="btn btn-primary" type="submit">${adminExists ? "Change" : "Set"} Password</button>
      <a class="btn btn-outline-secondary" href="/admin/db-view">Cancel</a>
    </div>
  </form>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });

  app.post("/admin/set-password", async (req, res) => {
    try {
      const adminSettings = await loadAdminSettings();
      const adminExists = !!adminSettings.passwordHash;
      if (!adminExists || (await isAdminAuthed(req))) {
        const raw = await readBody(req);
        let newPassword = null;
        let currentPassword = null;
        if (raw.includes("=") || raw.includes("&")) {
          const params = new URLSearchParams(raw);
          newPassword = params.get("password") || params.get("newPassword");
          currentPassword = params.get("currentPassword");
        } else {
          try { const j = JSON.parse(raw); newPassword = j.password || j.newPassword; currentPassword = j.currentPassword; } catch {}
        }

        if (!newPassword || String(newPassword).length < 6) {
          return res.status(400).json({ ok: false, error: "New password required (min length 6)" });
        }

        if (adminExists) {
          if (!currentPassword || !bcrypt.compareSync(String(currentPassword), adminSettings.passwordHash)) {
            return res.status(403).json({ ok: false, error: "Current password required or invalid" });
          }
        }

        const salt = bcrypt.genSaltSync(10);
        const hash = bcrypt.hashSync(String(newPassword), salt);
        await saveAdminSettings({ passwordHash: hash });
        return res.json({ ok: true, message: adminExists ? "Password changed" : "Password set" });
      } else {
        return res.status(403).json({ ok: false, error: "Not authorized to set password" });
      }
    } catch (err) {
      console.error("/admin/set-password error:", err);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  app.get("/admin/logout", async (req, res) => {
    try {
      const token = getCookie(req, "admin_auth");
      if (token) await deleteAdminSession(token);
      res.setHeader("Set-Cookie", `admin_auth=; HttpOnly; Path=/; Max-Age=0`);
      return res.redirect("/admin/login");
    } catch (err) {
      console.error("/admin/logout error:", err);
      return res.status(500).send("Server error");
    }
  });

  // Viewer & JSON download
app.get("/admin/db-view", async (req, res) => {
  if (!(await isAdminAuthed(req))) return res.redirect("/admin/login");

  // Snapshot from in-memory DB
  const snapshot = {
    scores: { ...(db.scores || {}) },
    periods: { ...(db.periods || {}) },
    profileNames: { ...(db.profileNames || {}) },
  };

  // --- Contract info ---
  let contractInfo = { balance: "N/A", playerDeposits: {}, hasPaidStatus: {} };

  if (opts.contract) {
    try {
      const contract = opts.contract;

      // Contract pool balance (ETH)
      try {
        let balanceBN = await contract.poolBalance();
        contractInfo.balance = ethers.utils.formatEther(balanceBN);
      } catch (err) {
        console.error("Error fetching balance:", err);
        contractInfo.balance = "Error";
      }

      // Current players
      let currentPlayers = [];
      try {
        currentPlayers = Array.isArray(await contract.getCurrentPlayers())
          ? await contract.getCurrentPlayers()
          : [];
      } catch (err) {
        console.error("getCurrentPlayers() failed:", err);
      }

      // Player deposits & hasPaid
      const playerDeposits = {};
      const hasPaidStatus = {};

      for (const addr of currentPlayers) {
        // Deposit
        try {
          let depositBN = await contract.getPlayerDeposit(addr);
          depositBN = depositBN ?? ethers.BigNumber.from(0);
          playerDeposits[addr] = ethers.utils.formatEther(depositBN);
        } catch (err) {
          console.error(`Error fetching deposit for ${addr}:`, err);
          playerDeposits[addr] = "Error";
        }

        // HasPaid
        try {
          const paid = await contract.hasPaid(addr);
          hasPaidStatus[addr] = paid ? "Yes" : "No";
        } catch (err) {
          console.error(`Error fetching hasPaid for ${addr}:`, err);
          hasPaidStatus[addr] = "Error";
        }
      }

      contractInfo.playerDeposits = playerDeposits;
      contractInfo.hasPaidStatus = hasPaidStatus;
    } catch (err) {
      console.error("Contract info fetch failed:", err);
      contractInfo = { balance: "Error", playerDeposits: {}, hasPaidStatus: {} };
    }
  }

  // --- Tables ---
  const balanceTable = buildTable(
    ["Contract Balance (ETH)"],
    [{ "Contract Balance (ETH)": contractInfo.balance }]
  );

  const paymentsRows = Object.keys(contractInfo.playerDeposits).map(addr => ({
    player: addr,
    deposit: contractInfo.playerDeposits[addr],
    hasPaid: contractInfo.hasPaidStatus[addr],
  }));
  const paymentsTable = buildTable(["player", "deposit", "hasPaid"], paymentsRows);

  const scoreRows = Object.values(snapshot.scores).map(s => ({
    user_address: s.user_address || "",
    profile_name: s.profile_name || "",
    email: s.email || "",
    highest_score: String(s.highest_score ?? ""),
    last_score: String(s.last_score ?? ""),
    games_played: String(s.games_played ?? ""),
    last_updated: s.last_updated || "",
  }));
  const scoreTable = buildTable(
    ["user_address", "profile_name", "email", "highest_score", "last_score", "games_played", "last_updated"],
    scoreRows
  );

  const periodRows = Object.entries(snapshot.periods).map(([idx, p]) => ({
    periodIndex: idx,
    status: p.status || "",
    txHash: p.txHash || "",
    payouts: p.payouts ? JSON.stringify(p.payouts, null, 0) : "",
    error: p.error || "",
    updated_at: p.updated_at || "",
  }));
  const periodsTable = buildTable(
    ["periodIndex", "status", "txHash", "payouts", "error", "updated_at"],
    periodRows
  );

  const profileRows = Object.entries(snapshot.profileNames).map(([norm, owner]) => ({
    normalized_name: norm,
    owner_address: owner,
  }));
  const profileTable = buildTable(["normalized_name", "owner_address"], profileRows);

  // --- HTML ---
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>DB Viewer + Contract Data</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>body{padding:20px;}</style>
</head>
<body>
  <div class="container-fluid">
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h3>In-memory DB Viewer + Contract Data</h3>
      <div>
        <a class="btn btn-sm btn-outline-primary" href="/admin/db-download">Download JSON</a>
        <a class="btn btn-sm btn-outline-secondary" href="/admin/logout">Logout</a>
        <button class="btn btn-sm btn-outline-secondary" onclick="location.reload()">Refresh</button>
      </div>
    </div>

    <div class="mb-4">
      <h5>Contract Balance</h5>
      ${balanceTable}
    </div>

    <div class="mb-4">
      <h5>Player Deposits & Has Paid Status</h5>
      ${paymentsTable}
    </div>

    <div class="mb-4">
      <h5>Scores (${htmlEscape(String(scoreRows.length))})</h5>
      ${scoreTable}
    </div>

    <div class="mb-4">
      <h5>Periods (${htmlEscape(String(periodRows.length))})</h5>
      ${periodsTable}
    </div>

    <div class="mb-4">
      <h5>Profile Names (${htmlEscape(String(profileRows.length))})</h5>
      ${profileTable}
    </div>

    <footer class="text-muted small">This page is protected. Keep credentials secret.</footer>
  </div>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});







  app.get("/admin/db-download", async (req, res) => {
    if (!(await isAdminAuthed(req))) return res.redirect("/admin/login");
    const adminSettings = await loadAdminSettings();
    const filename = `db-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(JSON.stringify({
      scores: db.scores || {},
      periods: db.periods || {},
      profileNames: db.profileNames || {},
      admin: { hasPassword: !!adminSettings.passwordHash }
    }, null, 2));
  });
}
