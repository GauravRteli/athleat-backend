const express = require("express");
const healthRoutes = require("./healthRoutes");
const studentRoutes = require("./studentRoutes");
const missionConfigRoutes = require("./missionConfigRoutes");
const uploadRoutes = require("./uploadRoutes");

const router = express.Router();

router.use("/health", healthRoutes);
router.use("/students", studentRoutes);
router.use("/mission-config", missionConfigRoutes);
router.use("/uploads", uploadRoutes);

module.exports = router;
