const express = require("express");
const {
  getMe,
  postUnlock,
  getFoodPreferences,
  postFoodPreferences,
  getFoodPreferencesCatalog,
  getMissions,
  postSubmitMissionV1,
  postSubmitMissionV2,
} = require("../controllers/athleteController");
const { requireAthleteAuth } = require("../middleware/auth");

const router = express.Router();

router.use(requireAthleteAuth);
router.get("/me", getMe);
router.post("/unlock", postUnlock);
router.get("/food-prefs/catalog", getFoodPreferencesCatalog);
router.get("/food-prefs", getFoodPreferences);
router.post("/food-prefs", postFoodPreferences);
router.get("/missions", getMissions);
router.post("/missions/:missionId/submit-v1", postSubmitMissionV1);
router.post("/missions/:missionId/submit-v2", postSubmitMissionV2);

module.exports = router;
