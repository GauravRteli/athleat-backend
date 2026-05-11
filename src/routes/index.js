const express = require("express");
const healthRoutes = require("./healthRoutes");
const studentRoutes = require("./studentRoutes");
const missionConfigRoutes = require("./missionConfigRoutes");
const uploadRoutes = require("./uploadRoutes");
const authRoutes = require("./authRoutes");
const athleteRoutes = require("./athleteRoutes");
const knowledgeEntriesRoutes = require("./knowledgeEntriesRoutes");
const knowledgeFoldersRoutes = require("./knowledgeFoldersRoutes");
const mealsRoutes = require("./mealsRoutes");
const foodsRoutes = require("./foodsRoutes");
const libraryRoutes = require("./libraryRoutes");
const eerConfigRoutes = require("./eerConfigRoutes");
const chatRoutes = require("./chatRoutes");
const kezRoutes = require("./kezRoutes");
const { requireDashboardAuth } = require("../middleware/auth");

const router = express.Router();

router.use("/health", healthRoutes);
router.use("/auth", authRoutes);
router.use("/athlete", athleteRoutes);
router.use("/students", requireDashboardAuth, studentRoutes);
router.use("/mission-config", requireDashboardAuth, missionConfigRoutes);
router.use("/uploads", requireDashboardAuth, uploadRoutes);
router.use("/knowledge-entries", requireDashboardAuth, knowledgeEntriesRoutes);
router.use("/knowledge-folders", requireDashboardAuth, knowledgeFoldersRoutes);
router.use("/meals", requireDashboardAuth, mealsRoutes);
router.use("/foods", requireDashboardAuth, foodsRoutes);
router.use("/library", libraryRoutes);
router.use("/eer-config", requireDashboardAuth, eerConfigRoutes);
router.use("/chat", requireDashboardAuth, chatRoutes);
router.use("/kez", requireDashboardAuth, kezRoutes);

module.exports = router;
