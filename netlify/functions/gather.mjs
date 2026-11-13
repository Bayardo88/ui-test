// POST /api/gather: read the prototype behind a link and return the evidence
// the reviewer needs (Figma frames and layer outline, or a page's HTML and CSS).
import { env, json, checkAccess } from "../lib/env.mjs";
import { parseFigmaUrl, gatherFigma } from "../lib/figma.mjs";
import { gatherWeb } from "../lib/web.mjs";

const DEFAULT_SDS_FILE_KEY = "Z4MtKOfkNEzhMYJzN1q3kR";

export default async (req) => {
  const denied = checkAccess(req);
  if (denied) return denied;

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "The request could not be read." }, 400);
  }
  const url = String(body?.url || "").trim();
  if (!url) return json({ error: "Paste a prototype link first." }, 400);
  if (url.length > 2000) return json({ error: "That link is too long." }, 400);

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return json({ error: "That does not look like a link. It should start with https://" }, 400);
  }

  try {
    const figma = parseFigmaUrl(url);
    if (figma) {
      const token = env("FIGMA_TOKEN");
      if (!token) {
        return json(
          {
            error:
              "Figma links need a Figma access token. Add FIGMA_TOKEN in the site's environment variables in Netlify, or upload screenshots instead.",
            code: "figma_token",
          },
          400
        );
      }
      const sdsFileKey = env("SDS_FIGMA_FILE_KEY") || DEFAULT_SDS_FILE_KEY;
      const evidence = await gatherFigma(figma, {
        token,
        // Skip the library lookup when the prototype IS the design system file.
        sdsFileKey: sdsFileKey === figma.fileKey ? null : sdsFileKey,
      });
      return json({ evidence });
    }
    if (/(^|\.)figma\.com$/i.test(parsed.hostname)) {
      return json({ error: "This Figma link type is not supported. Use a design or prototype link." }, 400);
    }
    const evidence = await gatherWeb(url);
    return json({ evidence });
  } catch (e) {
    const status = e.status === 429 ? 429 : 422;
    return json({ error: e.message || "The prototype could not be read." }, status);
  }
};

export const config = { path: "/api/gather", method: "POST" };
