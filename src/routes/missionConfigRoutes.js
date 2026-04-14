const express = require("express");
const { getConfig, putConfig } = require("../controllers/missionConfigController");

const router = express.Router();

router.get("/", getConfig);
router.put("/", putConfig);

module.exports = router;
