const cloudinary = require("../config/cloudinary");

const FOLDER = process.env.CLOUDINARY_UPLOAD_FOLDER || "athleat";

async function uploadImage(base64Data, options = {}) {
  const folder = options.folder
    ? `${FOLDER}/${options.folder}`
    : FOLDER;

  const result = await cloudinary.uploader.upload(base64Data, {
    folder,
    resource_type: "image",
    transformation: [{ quality: "auto", fetch_format: "auto" }],
  });

  return {
    url: result.secure_url,
    publicId: result.public_id,
    width: result.width,
    height: result.height,
  };
}

module.exports = { uploadImage };
