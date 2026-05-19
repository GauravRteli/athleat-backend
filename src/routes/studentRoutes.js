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
} = require("../controllers/studentController");

const router = express.Router();

router.get("/", getStudents);
router.patch("/:studentId/feedback", patchStudentFeedback);
router.patch("/:studentId/missions/:missionId/feedback", patchMissionFeedback);
router.patch("/:studentId/missions/:missionId/slot-desc", patchMissionSlotDesc);
router.patch("/questions/:questionId/reply", patchQuestionReply);
router.get("/:studentId/prescreen", getPrescreenByStudent);
router.put("/:studentId/prescreen", putPrescreenByStudent);
router.get("/:studentId/missions", getMissionsByStudent);
router.put("/:studentId/missions/:missionId/progress", putMissionProgress);
router.post("/:studentId/missions/:missionId/submit-v1", postSubmitMissionV1);
router.post("/:studentId/missions/:missionId/submit-v2", postSubmitMissionV2);

module.exports = router;
