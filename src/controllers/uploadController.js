const { uploadImage, uploadFile, signDirectUpload } = require("../services/uploadService");

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

async function postFile(req, res, next) {
  try {
    const { file, filename, folder } = req.body;
    if (!file) {
      return res.status(400).json({ message: "file (base64 data-url) is required" });
    }
    const result = await uploadFile(file, { filename, folder });
    return res.status(200).json(result);
  } catch (error) {
    return next(error);
  }
}

// Returns a short-lived Cloudinary upload signature so the browser can POST
// the binary file directly to Cloudinary, bypassing Vercel's 4.5 MB request
// body limit (which trips `FUNCTION_PAYLOAD_TOO_LARGE` on large uploads).
async function postSign(req, res, next) {
  try {
    const { folder, resource_type, filename } = req.body || {};
    const result = signDirectUpload({
      folder,
      resourceType: resource_type,
      filename,
    });
    return res.status(200).json(result);
  } catch (error) {
    return next(error);
  }
}

module.exports = { postImage, postFile, postSign };
