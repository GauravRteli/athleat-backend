const bcrypt = require("bcryptjs");
const { query } = require("../config/postgres");
const env = require("../config/env");
const jwt = require("jsonwebtoken");

function issueDashboardToken() {
  if (!env.auth.jwtSecret) throw new Error("JWT secret is not configured.");
  return jwt.sign({ dashboard: true }, env.auth.jwtSecret, { expiresIn: env.auth.jwtExpiresIn });
}

async function getCredentialRow() {
  const result = await query(
    `SELECT id, password_hash FROM public.dashboard_credentials WHERE id = 1 LIMIT 1`,
  );
  return result.rows[0] || null;
}

async function setPasswordHash(hash) {
  await query(
    `INSERT INTO public.dashboard_credentials (id, password_hash, updated_at)
     VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
    [hash],
  );
}

/**
 * Coach dashboard login: verify bcrypt password, return JWT { dashboard: true }.
 * If no DB row yet, optional one-time bootstrap via DASHBOARD_BOOTSTRAP_PASSWORD (plain).
 */
async function loginDashboard({ password }) {
  const plain = String(password || "");
  if (!plain) {
    return { status: 400, body: { error: "Password is required." } };
  }

  let row = await getCredentialRow();
  const bootstrap = String(process.env.DASHBOARD_BOOTSTRAP_PASSWORD || "").trim();

  if (!row?.password_hash) {
    if (bootstrap && plain === bootstrap) {
      const hash = await bcrypt.hash(plain, 12);
      await setPasswordHash(hash);
      row = await getCredentialRow();
    } else {
      return {
        status: 503,
        body: {
          error:
            "Dashboard password is not initialized. Set DASHBOARD_BOOTSTRAP_PASSWORD on the server to match your first login, or run the SQL migration that seeds dashboard_credentials.",
        },
      };
    }
  }

  const ok = await bcrypt.compare(plain, row.password_hash);
  if (!ok) {
    return { status: 401, body: { error: "Invalid password." } };
  }

  return { status: 200, body: { token: issueDashboardToken() } };
}

async function changeDashboardPassword({ password, confirmPassword }) {
  const a = String(password || "");
  const b = String(confirmPassword || "");
  if (a.length < 8) {
    return { status: 400, body: { error: "Password must be at least 8 characters." } };
  }
  if (a !== b) {
    return { status: 400, body: { error: "Passwords do not match." } };
  }

  const hash = await bcrypt.hash(a, 12);
  await setPasswordHash(hash);
  return { status: 200, body: { ok: true, message: "Password updated." } };
}

module.exports = {
  loginDashboard,
  changeDashboardPassword,
};
