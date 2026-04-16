const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { query } = require("../config/postgres");
const env = require("../config/env");

function splitName(fullName) {
  const parts = String(fullName || "").trim().split(" ").filter(Boolean);
  return {
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" "),
  };
}

function issueToken(studentId) {
  if (!env.auth.jwtSecret) throw new Error("JWT secret is not configured.");
  return jwt.sign({ studentId }, env.auth.jwtSecret, { expiresIn: env.auth.jwtExpiresIn });
}

function shapeAthlete(row) {
  const fallback = splitName(row.full_name);
  return {
    id: row.id,
    firstName: row.first_name || fallback.firstName,
    lastName: row.last_name || fallback.lastName,
    email: row.email || "",
  };
}

async function signupAthlete({ firstName, lastName, email, password }) {
  const existing = await query(
    `SELECT id FROM public.students WHERE lower(email) = lower($1) LIMIT 1`,
    [email],
  );
  if (existing.rows[0]) {
    return { status: 409, body: { error: "An account with this email already exists." } };
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const thinkificUserId = `manual:${email}`;
  const fullName = `${firstName} ${lastName}`.trim();

  const created = await query(
    `INSERT INTO public.students
      (thinkific_user_id, full_name, first_name, last_name, email, password_hash, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     RETURNING id, first_name, last_name, full_name, email`,
    [thinkificUserId, fullName, firstName, lastName, email, passwordHash],
  );

  const athleteRow = created.rows[0];
  await query(
    `INSERT INTO public.student_unlocks (student_id, module_key)
     VALUES ($1, 'pre-screen')
     ON CONFLICT (student_id, module_key) DO NOTHING`,
    [athleteRow.id],
  );

  return {
    status: 200,
    body: {
      athlete: shapeAthlete(athleteRow),
      token: issueToken(athleteRow.id),
    },
  };
}

async function loginAthlete({ email, password }) {
  const result = await query(
    `SELECT id, first_name, last_name, full_name, email, password_hash
     FROM public.students
     WHERE lower(email) = lower($1)
     LIMIT 1`,
    [email],
  );
  const row = result.rows[0];
  if (!row || !row.password_hash) {
    return { status: 401, body: { error: "Invalid login credentials." } };
  }

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return { status: 401, body: { error: "Invalid login credentials." } };

  await query(`UPDATE public.students SET last_login = now(), updated_at = now() WHERE id = $1`, [row.id]);

  return {
    status: 200,
    body: {
      athlete: shapeAthlete(row),
      token: issueToken(row.id),
    },
  };
}

module.exports = {
  signupAthlete,
  loginAthlete,
};
