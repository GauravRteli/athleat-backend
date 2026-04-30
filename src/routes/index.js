const express = require("express");
const healthRoutes = require("./healthRoutes");
const studentRoutes = require("./studentRoutes");
const missionConfigRoutes = require("./missionConfigRoutes");
const uploadRoutes = require("./uploadRoutes");
const authRoutes = require("./authRoutes");
const athleteRoutes = require("./athleteRoutes");
const knowledgeEntriesRoutes = require("./knowledgeEntriesRoutes");
const mealsRoutes = require("./mealsRoutes");
const foodsRoutes = require("./foodsRoutes");
const libraryRoutes = require("./libraryRoutes");
const eerConfigRoutes = require("./eerConfigRoutes");

const router = express.Router();

router.use("/health", healthRoutes);
router.use("/auth", authRoutes);
router.use("/athlete", athleteRoutes);
router.use("/students", studentRoutes);
router.use("/mission-config", missionConfigRoutes);
router.use("/uploads", uploadRoutes);
router.use("/knowledge-entries", knowledgeEntriesRoutes);
router.use("/meals", mealsRoutes);
router.use("/foods", foodsRoutes);
router.use("/library", libraryRoutes);
router.use("/eer-config", eerConfigRoutes);

module.exports = router;
