// adminRoutes.js
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { ethers } from "ethers"; // <-- we need ethers.js

export default function registerAdminRoutes(app, db, opts = {}) {
  const ADMIN_SECRET = opts.adminSecret ?? null;
  const pool = opts.pool;
  const SESSION_TTL_MS = opts.sessionTtlMs ?? 60 * 60 * 1000; // 1 hour

  if (!pool) throw new Error("registerAdminRoutes requires opts.pool (pg Pool)");

  // --- Add blockchain config ---
  const CONTRACT_ADDRESS = opts.contractAddress; // contract address
  const CONTRACT_ABI = opts.contractAbi;         // ABI JSON
  const RPC_URL = opts.rpcUrl;                   // e.g., https://rpc.testnet.io
  const provider = RPC_URL ? new ethers.JsonRpcProvider(RPC_URL) : null;
  const contract = (provider && CONTRACT_ADDRESS && CONTRACT_ABI) ? new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider) : null;

  // --- Helper DB functions for admin settings & sessions ---
  async function loadAdminSettings() {
    const r = await pool.query(`SELECT v FROM admin_settings WHERE k = 'passwordHash' LIMIT 1`);
    if (r.rowCount === 0) return { passwordHash: null };
    const v = r.rows[0].v;
    return { passwordHash: v?.hash ?? null };
  }

  async function saveAdminSettings(adminData) {
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
    if (ADMIN_SECRET) {
      const header = req.headers["x-admin-secret"];
      const q = req.query?.secret;
      if (header === ADMIN_SECRET || q === ADMIN_SECRET) return true;
    }
    const token = getCookie(req, "admin_auth");
    if (!token) return false;
    const s = await getAdminSession(token);
    if (!s) return false;
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

  async function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  // --- Routes ---
  app.get("/admin/login", async (req, res) => {
    if (await isAdminAuthed(req)) return res.redirect("/admin/db-view");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<html>... your login form ...</html>`); // keep your current HTML
  });

  app.post("/admin/login", async (req, res) => {
    // ... keep your existing login logic ...
  });

  app.get("/admin/db-view", async (req, res) => {
    if (!(await isAdminAuthed(req))) return res.redirect("/admin/login");

    // snapshot from DB
    const snapshot = {
      scores: { ...(db.scores || {}) },
      periods: { ...(db.periods || {}) },
      profileNames: { ...(db.profileNames || {}) },
    };

    // --- Blockchain pool deposit section ---
    let poolDeposit = "N/A";
    let playerDeposits = [];
    if (contract) {
      try {
        const total = await contract.poolBalance(); // adjust method name to your contract
        poolDeposit = ethers.formatEther(total); // assuming it's in wei
        // Optional: get each player deposit
        for (const user of Object.values(snapshot.scores)) {
          if (user.user_address) {
            const dep = await contract.deposits(user.user_address); // adjust method name
            playerDeposits.push({
              address: user.user_address,
              deposit: ethers.formatEther(dep)
            });
          }
        }
      } catch (e) {
        console.error("Error fetching pool deposits:", e);
      }
    }

    const poolTable = buildTable(
      ["address", "deposit"],
      playerDeposits
    );

    // build HTML with all sections
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>DB Viewer</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>body{padding:20px;}</style>
</head>
<body>
  <div class="container-fluid">
    <h3>In-memory DB Viewer</h3>

    <div class="mb-4">
      <h5>Pool Deposit: ${htmlEscape(poolDeposit)} ETH</h5>
      ${poolTable}
    </div>

    <div class="mb-4">
      <h5>Scores</h5>
      ${buildTable(
        ["user_address","profile_name","email","highest_score","last_score","games_played","last_updated"],
        Object.values(snapshot.scores).map(s => ({
          user_address: s.user_address || "",
          profile_name: s.profile_name || "",
          email: s.email || "",
          highest_score: String(s.highest_score ?? ""),
          last_score: String(s.last_score ?? ""),
          games_played: String(s.games_played ?? ""),
          last_updated: s.last_updated || ""
        }))
      )}
    </div>

    <div class="mb-4">
      <h5>Periods</h5>
      ${buildTable(
        ["periodIndex","status","txHash","payouts","error","updated_at"],
        Object.entries(snapshot.periods).map(([idx, p]) => ({
          periodIndex: idx,
          status: p.status || "",
          txHash: p.txHash || "",
          payouts: p.payouts ? JSON.stringify(p.payouts, null, 0) : "",
          error: p.error || "",
          updated_at: p.updated_at || ""
        }))
      )}
    </div>

    <div class="mb-4">
      <h5>Profile Names</h5>
      ${buildTable(
        ["normalized_name","owner_address"],
        Object.entries(snapshot.profileNames).map(([norm, owner]) => ({ normalized_name: norm, owner_address: owner }))
      )}
    </div>
  </div>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });
}
