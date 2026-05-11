const cloudinary = require("../config/cloudinary");

const FOLDER = process.env.CLOUDINARY_UPLOAD_FOLDER || "athleat";

async function uploadImage(base64Data, options = {}) {
  const folder = options.folder
    ? `${FOLDER}/${options.folder}`
    : FOLDER;

  const result = await cloudinary.uploader.upload(base64Data, {
    folder,
    resource_type: "image",
  });

  return {
    url: result.secure_url,
    publicId: result.public_id,
    width: result.width,
    height: result.height,
  };
}

// Upload an arbitrary file (PDF, DOCX, PPTX, TXT, CSV, etc.) to Cloudinary
// using the `raw` resource type so non-image binaries are accepted and served
// back as a downloadable URL.
async function uploadFile(base64Data, options = {}) {
  const folder = options.folder
    ? `${FOLDER}/${options.folder}`
    : FOLDER;

  const ext = (options.filename || "").split(".").pop()?.toLowerCase() || "";
  const isImage = ["jpg", "jpeg", "png", "gif", "webp"].includes(ext);
  const resourceType = isImage ? "image" : "raw";

  const uploadOptions = {
    folder,
    resource_type: resourceType,
    use_filename: true,
    unique_filename: true,
    overwrite: false,
  };
  if (options.filename) uploadOptions.public_id = options.filename.replace(/\.[^.]+$/, "");

  const result = await cloudinary.uploader.upload(base64Data, uploadOptions);

  return {
    url: result.secure_url,
    publicId: result.public_id,
    bytes: result.bytes,
    format: result.format || ext,
    resourceType,
  };
}

// Upload by remote HTTPS URL — Cloudinary's SDK accepts a URL directly so we
// can pipe AI-generated image URLs (e.g. OpenAI Images) straight into the
// asset library without round-tripping bytes through Node.
async function uploadRemoteUrl(remoteUrl, options = {}) {
  if (!remoteUrl || !/^https?:\/\//i.test(remoteUrl)) {
    throw new Error("uploadRemoteUrl requires an http(s) URL");
  }
  const folder = options.folder
    ? `${FOLDER}/${options.folder}`
    : FOLDER;

  const result = await cloudinary.uploader.upload(remoteUrl, {
    folder,
    resource_type: "image",
  });

  return {
    url: result.secure_url,
    publicId: result.public_id,
    width: result.width,
    height: result.height,
  };
}

module.exports = { uploadImage, uploadFile, uploadRemoteUrl };
