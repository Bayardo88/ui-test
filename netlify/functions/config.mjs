// GET /api/config: tells the page what is set up, without exposing any secret.
import { env, json } from "../lib/env.mjs";

export default async () =>
  json({
    aiConfigured: Boolean(env("ANTHROPIC_API_KEY")),
    figmaConfigured: Boolean(env("FIGMA_TOKEN")),
    passcodeRequired: Boolean(env("APP_PASSCODE")),
    model: env("ANTHROPIC_MODEL") || "claude-sonnet-5-5",
  });

export const config = { path: "/api/config", method: "GET" };
