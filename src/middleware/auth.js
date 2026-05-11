const jwt = require("jsonwebtoken");
const env = require("../config/env");

function getBearerToken(authHeader) {
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

function requireAthleteAuth(req, res, next) {
  if (!env.auth.jwtSecret) {
    return res.status(500).json({ error: "JWT secret is not configured." });
  }

  const token = getBearerToken(req.headers.authorization);
  if (!token) return res.status(401).json({ error: "Unauthorized." });

  try {
    const payload = jwt.verify(token, env.auth.jwtSecret);
    if (!payload?.studentId) return res.status(401).json({ error: "Unauthorized." });
    req.auth = { studentId: payload.studentId };
    return next();
  } catch {
    return res.status(401).json({ error: "Unauthorized." });
  }
}

function requireDashboardAuth(req, res, next) {
  if (!env.auth.jwtSecret) {
    return res.status(500).json({ error: "JWT secret is not configured." });
  }

  const token = getBearerToken(req.headers.authorization);
  if (!token) return res.status(401).json({ error: "Unauthorized." });

  try {
    const payload = jwt.verify(token, env.auth.jwtSecret);
    if (!payload?.dashboard) return res.status(401).json({ error: "Unauthorized." });
    req.dashboardAuth = { ok: true };
    return next();
  } catch {
    return res.status(401).json({ error: "Unauthorized." });
  }
}

module.exports = {
  requireAthleteAuth,
  requireDashboardAuth,
};
