// adminRoutes.js
// Usage: registerAdminRoutes(app, db, { adminSecret: process.env.ADMIN_SECRET || null });

import bcrypt from "bcryptjs";
import crypto from "crypto";

export default function registerAdminRoutes(app, db, opts = {}) {
  const ADMIN_SECRET = opts.adminSecret ?? null;
  const SESSION_TTL_MS = opts.sessionTtlMs ?? 60 * 60 * 1000; // 1 hour

  // --- Helpers ---
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

  // Check admin auth: either valid session token cookie OR ADMIN_SECRET header/query
  function isAdminAuthed(req) {
    // ADMIN_SECRET (env) bypass - header or query param
    if (ADMIN_SECRET) {
      const header = req.headers["x-admin-secret"];
      const q = req.query?.secret;
      if (header === ADMIN_SECRET || q === ADMIN_SECRET) return true;
    }

    // session cookie
    const token = getCookie(req, "admin_auth");
    if (!token) return false;
    db.adminSessions = db.adminSessions || {};
    const s = db.adminSessions[token];
    if (!s) return false;
    if (s.expiresAt < Date.now()) {
      // expired, remove it
      delete db.adminSessions[token];
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

  // Build table (same as before)
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

  // --- Auth / password management routes ---

  // GET login form
  app.get("/admin/login", (req, res) => {
    // if already authed, redirect to viewer
    if (isAdminAuthed(req)) return res.redirect("/admin/db-view");

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

  // Helper to parse small urlencoded bodies (we avoid adding body-parser here)
  async function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  // POST login (form or programmatic)
  app.post("/admin/login", async (req, res) => {
    try {
      // If ADMIN_SECRET present and matches, accept immediately (no password)
      if (ADMIN_SECRET) {
        const header = req.headers["x-admin-secret"];
        const q = req.query?.secret;
        if (header === ADMIN_SECRET || q === ADMIN_SECRET) {
          // create session token
          const token = crypto.randomBytes(24).toString("hex");
          db.adminSessions = db.adminSessions || {};
          db.adminSessions[token] = { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS };
          // set cookie (HttpOnly). secure flag not set by default; set if req.secure
          const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
          res.setHeader("Set-Cookie", `admin_auth=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS/1000)}${secure ? "; Secure" : ""}`);
          return res.redirect("/admin/db-view");
        }
      }

      // Read body (may be urlencoded form or JSON)
      const raw = await readBody(req);
      let password = null;
      if (raw.startsWith("password=") || raw.includes("&")) {
        // urlencoded
        const params = new URLSearchParams(raw);
        password = params.get("password");
      } else {
        // try json
        try { const j = JSON.parse(raw); password = j.password; } catch {}
      }
      if (!password) return res.status(400).send("Missing password");

      // check stored hash
      db.admin = db.admin || {};
      const hash = db.admin.passwordHash;
      if (!hash) {
        return res.status(400).send("No admin password set. Use /admin/set-password to create one or set ADMIN_SECRET.");
      }
      const ok = bcrypt.compareSync(String(password), hash);
      if (!ok) return res.status(403).send("Invalid password");

      // create session token
      const token = crypto.randomBytes(24).toString("hex");
      db.adminSessions = db.adminSessions || {};
      db.adminSessions[token] = { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS };
      const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
      res.setHeader("Set-Cookie", `admin_auth=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS/1000)}${secure ? "; Secure" : ""}`);
      return res.redirect("/admin/db-view");
    } catch (err) {
      console.error("/admin/login error:", err);
      return res.status(500).send("Server error");
    }
  });

// GET set-password form
app.get("/admin/set-password", (req, res) => {
  // Check if admin password exists
  const adminExists = !!(db.admin && db.admin.passwordHash);
  
  // If password exists, require authentication
  if (adminExists && !isAdminAuthed(req)) {
    return res.redirect("/admin/login");
  }
  
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



  // POST set-password - bootstrapping allowed if no password exists
  // body: { password, currentPassword? } OR urlencoded form
  app.post("/admin/set-password", async (req, res) => {
    try {
      // Authorization: allow if any of:
      // - ADMIN_SECRET matches header/query
      // - already authenticated session (isAdminAuthed)
      // - OR no password exists yet (bootstrapping)
      const adminExists = !!(db.admin && db.admin.passwordHash);
      if (!adminExists || isAdminAuthed(req)) {
        // read body
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

        // If admin exists, verify currentPassword
        if (adminExists) {
          const storedHash = db.admin.passwordHash;
          if (!currentPassword || !bcrypt.compareSync(String(currentPassword), storedHash)) {
            return res.status(403).json({ ok: false, error: "Current password required or invalid" });
          }
        }

        // set new hash
        const salt = bcrypt.genSaltSync(10);
        const hash = bcrypt.hashSync(String(newPassword), salt);
        db.admin = db.admin || {};
        db.admin.passwordHash = hash;

        return res.json({ ok: true, message: adminExists ? "Password changed" : "Password set" });
      } else {
        return res.status(403).json({ ok: false, error: "Not authorized to set password" });
      }
    } catch (err) {
      console.error("/admin/set-password error:", err);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  // GET logout - remove session token
  app.get("/admin/logout", (req, res) => {
    try {
      const token = getCookie(req, "admin_auth");
      if (token && db.adminSessions && db.adminSessions[token]) {
        delete db.adminSessions[token];
      }
      // unset cookie
      res.setHeader("Set-Cookie", `admin_auth=; HttpOnly; Path=/; Max-Age=0`);
      return res.redirect("/admin/login");
    } catch (err) {
      console.error("/admin/logout error:", err);
      return res.status(500).send("Server error");
    }
  });

  // --- Protected viewer & download ---
  app.get("/admin/db-view", (req, res) => {
    if (!isAdminAuthed(req)) return res.redirect("/admin/login");

    const snapshot = {
      scores: { ...(db.scores || {}) },
      periods: { ...(db.periods || {}) },
      profileNames: { ...(db.profileNames || {}) },
    };

    const scoreRows = Object.values(snapshot.scores).map(s => ({
      user_address: s.user_address || "",
      profile_name: s.profile_name || "",
      email: s.email || "",
      highest_score: String(s.highest_score ?? ""),
      last_score: String(s.last_score ?? ""),
      games_played: String(s.games_played ?? ""),
      last_updated: s.last_updated || ""
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
      updated_at: p.updated_at || ""
    }));
    const periodsTable = buildTable(
      ["periodIndex", "status", "txHash", "payouts", "error", "updated_at"],
      periodRows
    );

    const profileRows = Object.entries(snapshot.profileNames).map(([norm, owner]) => ({
      normalized_name: norm,
      owner_address: owner
    }));
    const profileTable = buildTable(["normalized_name", "owner_address"], profileRows);

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>DB Viewer</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>body{padding:20px;}</style>
</head>
<body>
  <div class="container-fluid">
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h3>In-memory DB Viewer</h3>
      <div>
        <a class="btn btn-sm btn-outline-primary" href="/admin/db-download">Download JSON</a>
        <a class="btn btn-sm btn-outline-secondary" href="/admin/logout">Logout</a>
        <button class="btn btn-sm btn-outline-secondary" onclick="location.reload()">Refresh</button>
      </div>
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

  app.get("/admin/db-download", (req, res) => {
    if (!isAdminAuthed(req)) return res.redirect("/admin/login");
    const filename = `db-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(JSON.stringify({
      scores: db.scores || {},
      periods: db.periods || {},
      profileNames: db.profileNames || {},
      admin: { hasPassword: !!(db.admin && db.admin.passwordHash) }
    }, null, 2));
  });
}
