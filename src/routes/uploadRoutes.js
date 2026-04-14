const express = require("express");
const { postImage } = require("../controllers/uploadController");

const router = express.Router();

router.post("/image", postImage);

module.exports = router;
