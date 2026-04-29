const { getEerConfig, updateEerConfig } = require("../services/eerConfigService");

async function getConfig(req, res, next) {
  try {
    const data = await getEerConfig();
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function putConfig(req, res, next) {
  try {
    const data = await updateEerConfig(req.body || {});
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getConfig, putConfig };
