const express = require("express");
const { getAll, postFood } = require("../controllers/foodsController");

const router = express.Router();

router.get("/", getAll);
router.post("/", postFood);

module.exports = router;
