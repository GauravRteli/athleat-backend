const { signupAthlete, loginAthlete } = require("../services/authService");

async function postSignup(req, res, next) {
  try {
    const firstName = String(req.body?.firstName || "").trim();
    const lastName = String(req.body?.lastName || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!firstName || !lastName || !email || password.length < 8) {
      return res.status(400).json({ error: "Invalid signup payload." });
    }

    const result = await signupAthlete({ firstName, lastName, email, password });
    return res.status(result.status).json(result.body);
  } catch (error) {
    return next(error);
  }
}

async function postLogin(req, res, next) {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const result = await loginAthlete({ email, password });
    return res.status(result.status).json(result.body);
  } catch (error) {
    return next(error);
  }
}

function postForgotPassword(req, res) {
  return res.status(200).json({
    ok: true,
    message: "If that email is registered, a reset link is on its way.",
  });
}

module.exports = {
  postSignup,
  postLogin,
  postForgotPassword,
};
