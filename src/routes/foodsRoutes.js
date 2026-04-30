const express = require("express");
const {
  getAll,
  getOne,
  postFood,
  patchFood,
  removeFood,
} = require("../controllers/foodsController");

const router = express.Router();

router.get("/", getAll);
router.get("/:id", getOne);
router.post("/", postFood);
router.patch("/:id", patchFood);
router.delete("/:id", removeFood);

module.exports = router;
