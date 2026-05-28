const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const apiRoutes = require("./routes");
const errorHandler = require("./middleware/errorHandler");
// 
const app = express();

app.use(helmet());
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
// 
app.use(express.json({ limit: "50mb" }));
// Skip the chatty knowledge-entries polling endpoint from the request log so
// the [rag][indexer …] tracking lines stay readable. Other endpoints log
// normally.
app.use(
  morgan("dev", {
    skip: (req) =>
      req.method === "GET" && req.originalUrl.startsWith("/api/knowledge-entries"),
  }),
);

app.get("/", (req, res) => {
  res.json({
    message: "Athleat backend is running",
    docs: "/api/health",
  });
});

app.use("/api", apiRoutes);

app.use(errorHandler);

module.exports = app;
