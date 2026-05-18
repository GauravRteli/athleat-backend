const express = require("express");
const { postImage, postFile, postSign } = require("../controllers/uploadController");

const router = express.Router();

router.post("/image", postImage);
router.post("/file", postFile);
router.post("/sign", postSign);

module.exports = router;
