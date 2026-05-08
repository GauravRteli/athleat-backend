const express = require("express");
const { postTestChat } = require("../controllers/chatController");

const router = express.Router();

router.post("/test", postTestChat);

module.exports = router;
