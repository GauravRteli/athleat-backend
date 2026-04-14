const { getMissionConfig, saveMissionConfig } = require("../services/missionConfigService");

async function getConfig(req, res, next) {
  try {
    const config = await getMissionConfig();
    return res.status(200).json({ data: config });
  } catch (error) {
    return next(error);
  }
}

async function putConfig(req, res, next) {
  try {
    const { configs } = req.body;
    await saveMissionConfig(configs);
    return res.status(200).json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getConfig, putConfig };
