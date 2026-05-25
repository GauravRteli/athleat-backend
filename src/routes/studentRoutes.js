const express = require("express");
const {
  getStudents,
  patchStudentFeedback,
  patchMissionFeedback,
  patchQuestionReply,
  getPrescreenByStudent,
  putPrescreenByStudent,
  getMissionsByStudent,
  putMissionProgress,
  postSubmitMissionV1,
  postSubmitMissionV2,
  patchMissionSlotDesc,
  patchMissionSlotLoadDay,
  patchMissionSlotTitle,
  getStudentEerOverrides,
  patchStudentEerOverrides,
  getFoodPrefsCatalog,
} = require("../controllers/studentController");

const router = express.Router();

router.get("/", getStudents);
router.get("/food-prefs/catalog", getFoodPrefsCatalog);
router.patch("/:studentId/feedback", patchStudentFeedback);
router.patch("/:studentId/missions/:missionId/feedback", patchMissionFeedback);
router.patch("/:studentId/missions/:missionId/slot-desc", patchMissionSlotDesc);
router.patch("/:studentId/missions/:missionId/slot-load-day", patchMissionSlotLoadDay);
router.patch("/:studentId/missions/:missionId/slot-title", patchMissionSlotTitle);
router.patch("/questions/:questionId/reply", patchQuestionReply);
router.get("/:studentId/prescreen", getPrescreenByStudent);
router.put("/:studentId/prescreen", putPrescreenByStudent);
router.get("/:studentId/missions", getMissionsByStudent);
router.put("/:studentId/missions/:missionId/progress", putMissionProgress);
router.post("/:studentId/missions/:missionId/submit-v1", postSubmitMissionV1);
router.post("/:studentId/missions/:missionId/submit-v2", postSubmitMissionV2);

// v5.2 — per-athlete EER overrides
router.get("/:studentId/eer-overrides", getStudentEerOverrides);
router.patch("/:studentId/eer-overrides", patchStudentEerOverrides);

module.exports = router;
