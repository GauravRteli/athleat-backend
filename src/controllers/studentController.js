const {
  listStudentsForDashboard,
  updateStudentFeedback,
  updateMissionFeedback,
  replyToQuestion,
  getStudentPrescreen,
  upsertStudentPrescreen,
} = require("../services/studentService");

async function getStudents(req, res, next) {
  try {
    const students = await listStudentsForDashboard();
    return res.status(200).json({ data: students, count: students.length });
  } catch (error) {
    return next(error);
  }
}

async function patchStudentFeedback(req, res, next) {
  try {
    const { studentId } = req.params;
    const { kerryFeedback, feedbackStatus } = req.body;
    await updateStudentFeedback(studentId, kerryFeedback, feedbackStatus);
    return res.status(200).json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

async function patchMissionFeedback(req, res, next) {
  try {
    const { studentId, missionId } = req.params;
    const { kerryFeedback, feedbackStatus, v3 } = req.body;
    await updateMissionFeedback(studentId, missionId, kerryFeedback, feedbackStatus, v3);
    return res.status(200).json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

async function patchQuestionReply(req, res, next) {
  try {
    const { questionId } = req.params;
    const { reply } = req.body;
    await replyToQuestion(questionId, reply);
    return res.status(200).json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

async function getPrescreenByStudent(req, res, next) {
  try {
    const { studentId } = req.params;
    const prescreen = await getStudentPrescreen(studentId);
    return res.status(200).json({ data: prescreen });
  } catch (error) {
    return next(error);
  }
}

async function putPrescreenByStudent(req, res, next) {
  try {
    const { studentId } = req.params;
    await upsertStudentPrescreen(studentId, req.body || {});
    return res.status(200).json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getStudents,
  patchStudentFeedback,
  patchMissionFeedback,
  patchQuestionReply,
  getPrescreenByStudent,
  putPrescreenByStudent,
};
