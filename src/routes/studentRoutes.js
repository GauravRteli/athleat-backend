const express = require("express");
const {
  getStudents,
  patchStudentFeedback,
  patchMissionFeedback,
  patchQuestionReply,
  getPrescreenByStudent,
  putPrescreenByStudent,
} = require("../controllers/studentController");

const router = express.Router();

router.get("/", getStudents);
router.patch("/:studentId/feedback", patchStudentFeedback);
router.patch("/:studentId/missions/:missionId/feedback", patchMissionFeedback);
router.patch("/questions/:questionId/reply", patchQuestionReply);
router.get("/:studentId/prescreen", getPrescreenByStudent);
router.put("/:studentId/prescreen", putPrescreenByStudent);

module.exports = router;
