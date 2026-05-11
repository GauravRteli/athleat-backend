const express = require("express");
const {
  mealAnalysisGet,
  mealAnalysisPost,
  mealCarouselPost,
  mealCarouselDraftsGet,
  mealCarouselDraftsPost,
  saveSuggestionPost,
} = require("../controllers/kezController");

const router = express.Router();

router.get("/meal-analysis", mealAnalysisGet);
router.post("/meal-analysis", mealAnalysisPost);
router.post("/meal-carousel", mealCarouselPost);
router.get("/meal-carousel-drafts", mealCarouselDraftsGet);
router.post("/meal-carousel-drafts", mealCarouselDraftsPost);
router.post("/save-suggestion", saveSuggestionPost);

module.exports = router;
