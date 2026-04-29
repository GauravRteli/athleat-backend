const express = require("express");
const {
  getAll,
  getOne,
  postMeal,
  patchMeal,
  deleteMeal,
} = require("../controllers/mealsController");

const router = express.Router();

router.get("/", getAll);
router.get("/:id", getOne);
router.post("/", postMeal);
router.patch("/:id", patchMeal);
router.delete("/:id", deleteMeal);

module.exports = router;
