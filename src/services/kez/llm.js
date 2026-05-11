const env = require("../../config/env");

function anthropicImageBlockFromUrl(imageUrl) {
  const trimmed = typeof imageUrl === "string" ? imageUrl.trim() : "";
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(trimmed);
  if (m) {
    return {
      type: "image",
      source: { type: "base64", media_type: m[1], data: m[2] },
    };
  }
  return { type: "image", source: { type: "url", url: trimmed } };
}

function openaiImagePartFromUrl(imageUrl) {
  const trimmed = typeof imageUrl === "string" ? imageUrl.trim() : "";
  return { type: "image_url", image_url: { url: trimmed } };
}

function summarizePartsForLog(parts) {
  return parts.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text?.slice(0, 2000) + (p.text?.length > 2000 ? "…[truncated]" : "") };
    const u = p.url || "";
    if (u.startsWith("data:image/")) return { type: "image", url: `[data URL, ${Math.round(u.length / 1024)} KB — omitted]` };
    return { type: "image", url: u };
  });
}

async function callLlmUserContent(parts, { system = "", json = false } = {}) {
  if (env.anthropic.apiKey) {
    const anthropicParts = parts.map((p) => {
      if (p.type === "text") return { type: "text", text: p.text };
      return anthropicImageBlockFromUrl(p.url);
    });

    const body = {
      model: env.anthropic.model,
      max_tokens: 4096,
      system: json
        ? `${system}\nReply with VALID JSON only. No markdown, no preamble, no code fences.`.trim()
        : system,
      messages: [{ role: "user", content: anthropicParts }],
    };
    console.log(
      "[Kez LLM → Anthropic]",
      JSON.stringify(
        {
          model: body.model,
          system: body.system,
          user_content_summary: summarizePartsForLog(parts),
        },
        null,
        2,
      ),
    );
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.anthropic.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Anthropic ${res.status}: ${errBody}`);
    }
    const data = await res.json();
    return data?.content?.[0]?.text || "";
  }

  if (env.openai.apiKey) {
    const openaiContent = parts.map((p) => {
      if (p.type === "text") return { type: "text", text: p.text };
      return openaiImagePartFromUrl(p.url);
    });
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openai.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.openai.chatModel,
        messages: [
          ...(system
            ? [
                {
                  role: "system",
                  content: json ? `${system}\nReply with VALID JSON only. No markdown.` : system,
                },
              ]
            : []),
          { role: "user", content: openaiContent },
        ],
        temperature: 0.2,
        ...(json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`OpenAI ${res.status}: ${errBody}`);
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || "";
  }

  throw new Error("No LLM API key configured (ANTHROPIC_API_KEY or OPENAI_API_KEY in backend/.env).");
}

async function callLlmText(prompt, opts) {
  return callLlmUserContent([{ type: "text", text: prompt }], opts);
}

function extractJsonObject(text) {
  const s = String(text || "").trim();
  const match = s.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

module.exports = { callLlmUserContent, callLlmText, extractJsonObject };
