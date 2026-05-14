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
} = require("../controllers/kezController");

const router = express.Router();

router.get("/meal-analysis", mealAnalysisGet);
router.post("/meal-analysis", mealAnalysisPost);
router.post("/meal-analysis-v3", mealAnalysisV3Post);
router.post("/meal-carousel", mealCarouselPost);
router.get("/meal-carousel-drafts", mealCarouselDraftsGet);
router.post("/meal-carousel-drafts", mealCarouselDraftsPost);
router.post("/mission-feedback-draft", missionFeedbackDraftPost);
router.post("/student-feedback-draft", studentFeedbackDraftPost);
router.post("/save-suggestion", saveSuggestionPost);
router.post("/generate-meal-image", mealImageGeneratePost);

module.exports = router;
