const { uploadImage } = require("../services/uploadService");

async function postImage(req, res, next) {
  try {
    const { image, folder } = req.body;
    if (!image) {
      return res.status(400).json({ message: "image (base64 data-url) is required" });
    }
    const result = await uploadImage(image, { folder });
    return res.status(200).json(result);
  } catch (error) {
    return next(error);
  }
}

module.exports = { postImage };
