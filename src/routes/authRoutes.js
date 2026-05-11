const express = require("express");
const {
  postSignup,
  postLogin,
  postForgotPassword,
  postDashboardLogin,
  getDashboardSession,
  postDashboardPassword,
} = require("../controllers/authController");
const { requireDashboardAuth } = require("../middleware/auth");

const router = express.Router();

router.post("/signup", postSignup);
router.post("/login", postLogin);
router.post("/forgot-password", postForgotPassword);

router.post("/dashboard/login", postDashboardLogin);
router.get("/dashboard/session", requireDashboardAuth, getDashboardSession);
router.post("/dashboard/password", requireDashboardAuth, postDashboardPassword);

module.exports = router;
