const express = require("express");
const {
  getAll,
  postEntry,
  patchEntry,
  deleteEntry,
} = require("../controllers/knowledgeEntriesController");

const router = express.Router();

router.get("/", getAll);
router.post("/", postEntry);
router.patch("/:id", patchEntry);
router.delete("/:id", deleteEntry);

module.exports = router;
