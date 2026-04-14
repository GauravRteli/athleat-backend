const express = require("express");
const {
  getStudents,
  patchStudentFeedback,
  patchMissionFeedback,
  patchQuestionReply,
} = require("../controllers/studentController");

const router = express.Router();

router.get("/", getStudents);
router.patch("/:studentId/feedback", patchStudentFeedback);
router.patch("/:studentId/missions/:missionId/feedback", patchMissionFeedback);
router.patch("/questions/:questionId/reply", patchQuestionReply);

module.exports = router;
