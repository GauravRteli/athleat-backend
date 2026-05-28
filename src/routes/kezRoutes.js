const express = require("express");
const {
  mealAnalysisGet,
  mealAnalysisPost,
  mealAnalysisV3Post,
  mealCarouselPost,
  mealCarouselDraftsGet,
  mealCarouselDraftsPost,
  missionFeedbackDraftPost,
  studentFeedbackDraftPost,
  saveSuggestionPost,
  mealImageGeneratePost,
  estimateMacrosPost,
  aiDraftPost,
  ingredientSearchGet,
  mealAnalysisResolvedItemsPatch,
  mealAnalysisSendToAthletePost,
  ingredientPromotePost,
  ingredientGenerateImagePost,
} = require("../controllers/kezController");

const router = express.Router();

router.get("/meal-analysis", mealAnalysisGet);
router.post("/meal-analysis", mealAnalysisPost);
router.patch("/meal-analysis/:id/resolved-items", mealAnalysisResolvedItemsPatch);
router.post("/meal-analysis/:id/send-to-athlete", mealAnalysisSendToAthletePost);
router.post("/meal-analysis-v3", mealAnalysisV3Post);
router.post("/meal-carousel", mealCarouselPost);
router.get("/meal-carousel-drafts", mealCarouselDraftsGet);
router.post("/meal-carousel-drafts", mealCarouselDraftsPost);
router.post("/mission-feedback-draft", missionFeedbackDraftPost);
router.post("/student-feedback-draft", studentFeedbackDraftPost);
router.post("/save-suggestion", saveSuggestionPost);
router.post("/generate-meal-image", mealImageGeneratePost);
router.post("/estimate-macros", estimateMacrosPost);
router.post("/ai-draft", aiDraftPost);

// Ingredient management — modal inside Kez Analysis view
router.get("/ingredients/search", ingredientSearchGet);
router.post("/ingredients/promote-to-verified", ingredientPromotePost);
router.post("/ingredients/:itemId/generate-image", ingredientGenerateImagePost);

module.exports = router;
