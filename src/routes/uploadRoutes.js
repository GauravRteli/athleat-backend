const express = require("express");
const { postImage, postFile } = require("../controllers/uploadController");

const router = express.Router();

router.post("/image", postImage);
router.post("/file", postFile);

module.exports = router;
