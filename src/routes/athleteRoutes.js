const express = require("express");
const {
  getMe,
  postUnlock,
  getFoodPreferences,
  postFoodPreferences,
  getFoodPreferencesCatalog,
  getMissions,
  getMissionConfigForAthlete,
  postSubmitMissionV1,
  postSubmitMissionV2,
  postAthleteKnowledgeChat,
  getAthleteNutritionTargets,
} = require("../controllers/athleteController");
const {
  getMyTrainingPlan,
  saveMyTrainingPlan,
  getMyGameDayPlan,
  saveMyGameDayPlan,
  getMyShoppingList,
  saveMyShoppingList,
} = require("../controllers/planningController");
const { postSign: postUploadSign } = require("../controllers/uploadController");
const { requireAthleteAuth } = require("../middleware/auth");

const router = express.Router();

router.use(requireAthleteAuth);
router.get("/me", getMe);
router.post("/unlock", postUnlock);
router.get("/food-prefs/catalog", getFoodPreferencesCatalog);
router.get("/food-prefs", getFoodPreferences);
router.post("/food-prefs", postFoodPreferences);
router.get("/missions", getMissions);
router.get("/nutrition-targets", getAthleteNutritionTargets);
router.get("/mission-config", getMissionConfigForAthlete);
router.post("/missions/:missionId/submit-v1", postSubmitMissionV1);
router.post("/missions/:missionId/submit-v2", postSubmitMissionV2);

// Planning Tools (v4 Athlete Dashboard — native JSX components)
router.get ("/training-plan", getMyTrainingPlan);
router.post("/training-plan", saveMyTrainingPlan);
router.get ("/game-day-plan", getMyGameDayPlan);
router.post("/game-day-plan", saveMyGameDayPlan);
router.get ("/shopping-list", getMyShoppingList);
router.post("/shopping-list", saveMyShoppingList);

router.post("/knowledge-chat", postAthleteKnowledgeChat);

// Cloudinary signed direct upload — athletes POST the binary file straight to
// Cloudinary, bypassing Vercel's 4.5 MB serverless body cap on submissions.
router.post("/uploads/sign", postUploadSign);

module.exports = router;
