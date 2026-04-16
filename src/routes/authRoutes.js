const express = require("express");
const { postSignup, postLogin, postForgotPassword } = require("../controllers/authController");

const router = express.Router();

router.post("/signup", postSignup);
router.post("/login", postLogin);
router.post("/forgot-password", postForgotPassword);

module.exports = router;
