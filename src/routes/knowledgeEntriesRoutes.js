const express = require("express");
const {
  getAll,
  postEntry,
  patchEntry,
  deleteEntry,
  reindexEntry,
  reindexAll,
} = require("../controllers/knowledgeEntriesController");

const router = express.Router();

// Admin route comes BEFORE the `/:id` routes so "admin" isn't matched as an
// id by Express.
router.post("/admin/reindex-all", reindexAll);

router.get("/", getAll);
router.post("/", postEntry);
router.patch("/:id", patchEntry);
router.delete("/:id", deleteEntry);
router.post("/:id/reindex", reindexEntry);

module.exports = router;
