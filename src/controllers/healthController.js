const { healthCheck } = require("../config/postgres");

async function getHealth(req, res) {
  try {
    const db = await healthCheck();

    return res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
      database: {
        connected: true,
        now: db.now,
      },
    });
  } catch (error) {
    return res.status(200).json({
      status: "degraded",
      timestamp: new Date().toISOString(),
      database: {
        connected: false,
        error: error.message,
      },
    });
  }
}

module.exports = {
  getHealth,
};
