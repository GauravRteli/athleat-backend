function errorHandler(err, req, res, next) {
  console.error("API Error:", err);

  return res.status(500).json({
    message: "Internal server error",
    details: err.message,
  });
}

module.exports = errorHandler;
