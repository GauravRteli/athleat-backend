const { query } = require("../config/postgres");

async function listStudentsForDashboard() {
  const studentsRes = await query(`
    SELECT id, thinkific_user_id, full_name, email, created_at,
           quest_xp, best_streak, badges_earned,
           feedback_status, kerry_feedback, feedback_approved_at
    FROM public.students
    ORDER BY created_at DESC
  `);

  const students = studentsRes.rows;
  if (!students.length) return [];

  const ids = students.map((s) => s.id);

  const [prescreenRes, blueprintRes, missionsRes, questionsRes] =
    await Promise.all([
      query(`SELECT * FROM public.prescreen WHERE student_id = ANY($1)`, [ids]),
      query(`SELECT * FROM public.blueprint_answers WHERE student_id = ANY($1)`, [ids]),
      query(`SELECT * FROM public.missions WHERE student_id = ANY($1) ORDER BY mission_id`, [ids]),
      query(`SELECT * FROM public.questions WHERE student_id = ANY($1) ORDER BY asked_at`, [ids]),
    ]);

  const prescreenMap = {};
  prescreenRes.rows.forEach((r) => { prescreenMap[r.student_id] = r; });

  const blueprintMap = {};
  blueprintRes.rows.forEach((r) => { blueprintMap[r.student_id] = r; });

  const missionsMap = {};
  missionsRes.rows.forEach((r) => {
    if (!missionsMap[r.student_id]) missionsMap[r.student_id] = {};
    missionsMap[r.student_id][r.mission_id] = r;
  });

  const questionsMap = {};
  questionsRes.rows.forEach((r) => {
    if (!questionsMap[r.student_id]) questionsMap[r.student_id] = [];
    questionsMap[r.student_id].push(r);
  });

  return students.map((s) => shapeDashboardStudent(s, prescreenMap[s.id], blueprintMap[s.id], missionsMap[s.id], questionsMap[s.id]));
}

function shapeDashboardStudent(s, ps, bp, missions, questions) {
  const prescreen = ps
    ? {
        dob: ps.dob,
        schoolYear: ps.school_year,
        referral: ps.referral,
        ethnicity: ps.ethnicity,
        bloodTest: ps.blood_test,
        medical: ps.medical || [],
        medicalDates: ps.medical_dates,
        supplements: ps.supplements,
        sex: ps.sex,
        menstrual: ps.menstrual,
        height: ps.height_cm != null ? String(ps.height_cm) : null,
        weight: ps.weight_kg != null ? String(ps.weight_kg) : null,
        weightTrend: ps.weight_trend,
        livingWith: ps.living_with || [],
        cooking: ps.cooking,
        cookingSkills: ps.cooking_skills,
        favFoods: ps.fav_foods,
        dislikeFoods: ps.dislike_foods,
        dietaryReqs: ps.dietary_reqs || [],
        eatingStyle: ps.eating_style || [],
        takeaway: ps.takeaway_frequency,
        takeawayFoods: ps.takeaway_foods,
        goals: ps.goals || [],
        biggestChallenges: ps.biggest_challenges || [],
        mealPriority: ps.meal_priority,
        topQuestions: ps.top_questions,
        infoSources: ps.info_sources || [],
        activityType: ps.activity_type || [],
        daysLow: ps.days_low != null ? String(ps.days_low) : null,
        daysMed: ps.days_med != null ? String(ps.days_med) : null,
        daysHigh: ps.days_high != null ? String(ps.days_high) : null,
        sessionLength: ps.session_length,
      }
    : {};

  const questAnswers = bp ? bp.answers : {};

  const shapedMissions = {};
  ["m1", "m2", "m3", "m4", "m5"].forEach((mid) => {
    const m = missions?.[mid];
    if (m) {
      shapedMissions[mid] = {
        id: m.id,
        status: m.status,
        submittedAt: m.submitted_at,
        v1: m.v1,
        v2: m.v2,
        v3: m.v3,
        v2SubmittedAt: m.v2_submitted_at,
        kerryFeedback: m.kerry_feedback || "",
        feedbackStatus: m.feedback_status || "none",
        feedbackApprovedAt: m.feedback_approved_at,
      };
    } else {
      shapedMissions[mid] = {
        status: "not_started",
        v1: null,
        v2: null,
        v3: null,
        kerryFeedback: "",
        feedbackStatus: "none",
      };
    }
  });

  const shapedQuestions = (questions || []).map((q) => ({
    id: q.id,
    text: q.text,
    askedAt: q.asked_at,
    status: q.status,
    reply: q.reply || "",
    repliedAt: q.replied_at,
  }));

  return {
    id: s.id,
    fullName: s.full_name,
    email: s.email,
    thinkificUserId: s.thinkific_user_id,
    submittedAt: s.created_at,
    questXP: s.quest_xp || 0,
    bestStreak: s.best_streak || 0,
    badgesEarned: (s.badges_earned || []).join(", "),
    feedbackStatus: s.feedback_status || "none",
    kerryFeedback: s.kerry_feedback || "",
    feedbackApprovedAt: s.feedback_approved_at,
    prescreen,
    questAnswers,
    missions: shapedMissions,
    questions: shapedQuestions,
  };
}

async function updateStudentFeedback(studentId, kerryFeedback, feedbackStatus) {
  const feedbackApprovedAt = feedbackStatus === "approved" ? new Date().toISOString() : null;
  await query(
    `UPDATE public.students
     SET kerry_feedback = $1, feedback_status = $2, feedback_approved_at = $3
     WHERE id = $4`,
    [kerryFeedback, feedbackStatus, feedbackApprovedAt, studentId],
  );
}

async function updateMissionFeedback(studentId, missionId, kerryFeedback, feedbackStatus, v3) {
  const feedbackApprovedAt = feedbackStatus === "approved" ? new Date().toISOString() : null;
  await query(
    `UPDATE public.missions
     SET kerry_feedback = $1, feedback_status = $2, feedback_approved_at = $3, v3 = $4
     WHERE student_id = $5 AND mission_id = $6`,
    [kerryFeedback, feedbackStatus, feedbackApprovedAt, JSON.stringify(v3), studentId, missionId],
  );
}

async function replyToQuestion(questionId, reply) {
  await query(
    `UPDATE public.questions
     SET reply = $1, status = 'answered', replied_at = now()
     WHERE id = $2`,
    [reply, questionId],
  );
}

module.exports = {
  listStudentsForDashboard,
  updateStudentFeedback,
  updateMissionFeedback,
  replyToQuestion,
};
