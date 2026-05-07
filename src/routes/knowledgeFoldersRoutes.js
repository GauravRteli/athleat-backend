const express = require("express");
const {
  getAll,
  postFolder,
  patchFolder,
  deleteFolder,
} = require("../controllers/knowledgeFoldersController");

const router = express.Router();

router.get("/", getAll);
router.post("/", postFolder);
router.patch("/:id", patchFolder);
router.delete("/:id", deleteFolder);

module.exports = router;
