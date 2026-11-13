// POST /api/analyze: run ONE test template on the gathered evidence with the
// Claude API and stream the result back. Runs at the edge so a long review is
// not cut off by a function time limit.
import { getTemplate, buildSystemPrompt, REPORT_TOOL } from "../../public/templates.js";
import { buildContent } from "../lib/content.js";

const DEFAULT_MODEL = "claude-sonnet-5-5";
const MAX_OUTPUT_TOKENS = 8000;
const MAX_TEXT_CHARS = 400_000;
const LANGUAGES = { en: "English", es: "Spanish" };

function env(name) {
  try {
    return Netlify.env.get(name) || "";
  } catch {
    return "";
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function accessDenied(req) {
  const expected = env("APP_PASSCODE");
  if (!expected) return false;
  const given = req.headers.get("x-app-passcode") || "";
  let diff = expected.length ^ given.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (given.charCodeAt(i) || 0);
  return diff !== 0;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  if (accessDenied(req)) return json({ error: "The access code is missing or wrong.", code: "passcode" }, 401);

  const apiKey = env("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json(
      { error: "The AI is not set up yet. Add ANTHROPIC_API_KEY in the site's environment variables in Netlify, then redeploy.", code: "api_key" },
      500
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "The request could not be read. If you uploaded screenshots, try fewer or smaller ones." }, 400);
  }

  const template = getTemplate(body?.templateId);
  if (!template) return json({ error: "Unknown test template." }, 400);

  const language = LANGUAGES[body?.language] || "English";
  const content = buildContent(body, template, language);
  if (!content) return json({ error: "There is nothing to review: no screens, screenshots or page markup." }, 400);

  const textSize = content.reduce((n, b) => n + (b.type === "text" ? b.text.length : 0), 0);
  if (textSize > MAX_TEXT_CHARS) return json({ error: "This prototype is too large to review in one go. Link to fewer frames." }, 413);

  const payload = {
    model: env("ANTHROPIC_MODEL") || DEFAULT_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
    system: [{ type: "text", text: buildSystemPrompt() }],
    tools: [REPORT_TOOL],
    tool_choice: { type: "tool", name: REPORT_TOOL.name },
    messages: [{ role: "user", content }],
  };

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return json({ error: "The AI service could not be reached. Try again." }, 502);
  }

  if (!upstream.ok) {
    let detail = "";
    try {
      const err = await upstream.json();
      detail = err?.error?.message || "";
    } catch {}
    const s = upstream.status;
    if (s === 401 || s === 403) return json({ error: "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in Netlify.", code: "api_key" }, 500);
    if (s === 404) return json({ error: `The AI model "${payload.model}" was not found. Set ANTHROPIC_MODEL in Netlify to a model your key can use.`, code: "model" }, 500);
    if (s === 429) return json({ error: "The AI is rate-limited right now.", code: "rate_limit" }, 429);
    if (s === 529 || s >= 500) return json({ error: "The AI service is busy.", code: "overloaded" }, 503);
    if (s === 413) return json({ error: "This prototype is too large to review in one go. Use fewer screens or screenshots." }, 413);
    return json({ error: detail ? `The AI could not run this test: ${detail}` : "The AI could not run this test." }, 400);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
};

export const config = { path: "/api/analyze" };
