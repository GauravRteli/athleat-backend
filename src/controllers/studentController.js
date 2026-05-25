const {
  listStudentsForDashboard,
  updateStudentFeedback,
  updateMissionFeedback,
  replyToQuestion,
  getStudentPrescreen,
  upsertStudentPrescreen,
  getStudentMissions,
  saveMissionProgress,
  submitMissionVersion,
  updateMissionSlotDesc,
  updateMissionSlotLoadDay,
  updateMissionSlotTitle,
  getEerOverrides,
  saveEerOverrides,
} = require("../services/studentService");
const { getFoodPrefsCatalog: loadFoodPrefsCatalog } = require("../services/athleteService");

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

async function getMissionsByStudent(req, res, next) {
  try {
    const { studentId } = req.params;
    const missions = await getStudentMissions(studentId);
    return res.status(200).json({ data: missions });
  } catch (error) {
    return next(error);
  }
}

async function putMissionProgress(req, res, next) {
  try {
    const { studentId, missionId } = req.params;
    await saveMissionProgress(studentId, missionId, req.body || {});
    return res.status(200).json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

async function postSubmitMissionV1(req, res, next) {
  try {
    const { studentId, missionId } = req.params;
    await submitMissionVersion(studentId, missionId, "v1", req.body?.v1 || {});
    return res.status(200).json({ ok: true });
  } catch (error) {
    if (error?.code === "MISSION_LOCKED") {
      return res.status(error.statusCode || 409).json({
        ok: false,
        error: error.message,
        code: error.code,
        missionId: error.missionId,
      });
    }
    return next(error);
  }
}

async function postSubmitMissionV2(req, res, next) {
  try {
    const { studentId, missionId } = req.params;
    await submitMissionVersion(studentId, missionId, "v2", req.body?.v2 || {});
    return res.status(200).json({ ok: true });
  } catch (error) {
    if (error?.code === "MISSION_LOCKED") {
      return res.status(error.statusCode || 409).json({
        ok: false,
        error: error.message,
        code: error.code,
        missionId: error.missionId,
      });
    }
    return next(error);
  }
}

async function patchMissionSlotDesc(req, res, next) {
  try {
    const { studentId, missionId } = req.params;
    const { version, slot_id: slotId, desc } = req.body || {};
    const updated = await updateMissionSlotDesc(studentId, missionId, version, slotId, desc);
    return res.status(200).json({ ok: true, [version]: updated });
  } catch (error) {
    return next(error);
  }
}

// PATCH /api/students/:studentId/missions/:missionId/slot-load-day
// Body: { version: "v1"|"v2", slot_id: string, load_day: string }
async function patchMissionSlotLoadDay(req, res, next) {
  try {
    const { studentId, missionId } = req.params;
    const { version, slot_id: slotId, load_day: loadDay, loadDay: loadDayCamel } =
      req.body || {};
    const updated = await updateMissionSlotLoadDay(
      studentId,
      missionId,
      version,
      slotId,
      loadDay ?? loadDayCamel,
    );
    return res.status(200).json({ ok: true, [version]: updated });
  } catch (error) {
    return next(error);
  }
}

// PATCH /api/students/:studentId/missions/:missionId/slot-title
// Body: { version: "v1"|"v2"|"v3", slot_id: string, title: string }
async function patchMissionSlotTitle(req, res, next) {
  try {
    const { studentId, missionId } = req.params;
    const { version, slot_id: slotId, title } = req.body || {};
    const updated = await updateMissionSlotTitle(studentId, missionId, version, slotId, title);
    return res.status(200).json({ ok: true, [version]: updated });
  } catch (error) {
    return next(error);
  }
}

// GET  /api/students/:studentId/eer-overrides              → { data: [...rows] }
// PATCH /api/students/:studentId/eer-overrides             body: { loadDay, overrides }
async function getStudentEerOverrides(req, res, next) {
  try {
    const { studentId } = req.params;
    const rows = await getEerOverrides(studentId);
    return res.status(200).json({ data: rows });
  } catch (error) {
    return next(error);
  }
}

async function patchStudentEerOverrides(req, res, next) {
  try {
    const { studentId } = req.params;
    const { loadDay, overrides } = req.body || {};
    if (!loadDay) {
      return res.status(400).json({ error: "loadDay is required" });
    }
    const row = await saveEerOverrides(studentId, loadDay, overrides);
    return res.status(200).json({ data: row });
  } catch (error) {
    return next(error);
  }
}

async function getFoodPrefsCatalog(req, res, next) {
  try {
    const categories = await loadFoodPrefsCatalog();
    return res.status(200).json({ categories });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getStudents,
  getFoodPrefsCatalog,
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
};
