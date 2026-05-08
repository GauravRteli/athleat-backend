const { chatTurn } = require("../services/rag/chat");

async function postTestChat(req, res, next) {
  try {
    const { messages, topK } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ message: "messages[] is required" });
    }
    const result = await chatTurn({ messages, topK });
    return res.status(200).json(result);
  } catch (error) {
    if (error.status && error.status >= 400 && error.status < 600) {
      return res
        .status(error.status)
        .json({ message: error.message || "Chat failed" });
    }
    return next(error);
  }
}

module.exports = { postTestChat };
