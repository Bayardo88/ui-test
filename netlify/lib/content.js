// Builds the message content sent to the Claude API for one template run.
// Plain web-standard JavaScript: imported by the edge function and by tests.
import { buildTemplatePrompt } from "../../public/templates.js";

const MAX_IMAGES = 12;

const str = (v, max) => String(v ?? "").slice(0, max);

/** Build the message content. Everything up to the cache marker is identical
 *  for every template run on the same prototype, so later runs reuse it. */
export function buildContent({ evidence = {}, screenshots = [], context = {} }, template, language) {
  const blocks = [];
  let images = 0;
  const text = (t) => blocks.push({ type: "text", text: t });

  const header = [
    "EVIDENCE FOR THIS PROTOTYPE",
    `Name: ${str(evidence.title, 200) || "Untitled prototype"}`,
    context.url ? `Link: ${str(context.url, 500)}` : null,
    `How it was collected: ${str(evidence.method, 200) || "Uploaded screenshots"}`,
    `Target viewport: ${str(context.viewport, 60) || "Desktop, 1440 px wide"}`,
    context.task ? `Primary user task: ${str(context.task, 600)}` : "Primary user task: not provided",
    context.notes ? `Notes from the designer: ${str(context.notes, 1500)}` : null,
  ].filter(Boolean);
  const notes = (evidence.notes || []).concat(evidence.warnings || []).slice(0, 12);
  if (notes.length) header.push("", "Collection notes:", ...notes.map((n) => "- " + str(n, 400)));
  text(header.join("\n"));

  const screens = Array.isArray(evidence.screens) ? evidence.screens.slice(0, 8) : [];
  screens.forEach((s, i) => {
    text(`SCREEN ${i + 1}: "${str(s.name, 120)}" (${s.width || "?"} x ${s.height || "?"} px)`);
    if (typeof s.imageUrl === "string" && /^https:\/\//.test(s.imageUrl) && images < MAX_IMAGES) {
      blocks.push({ type: "image", source: { type: "url", url: s.imageUrl } });
      images++;
    }
    if (s.outline) {
      text(
        `Layer outline of "${str(s.name, 120)}". Positions are relative to the screen. ` +
          "(raw) = not bound to a style or variable; comp=…(lib) = design system library instance; " +
          "contrast≈ is computed against the nearest ancestor fill, so confirm it against the screenshot.\n" +
          str(s.outline, 30_000)
      );
    }
  });

  (Array.isArray(screenshots) ? screenshots : []).forEach((shot, i) => {
    if (images >= MAX_IMAGES) return;
    if (!shot || typeof shot.data !== "string" || !/^image\/(png|jpeg|webp|gif)$/.test(shot.mediaType || "")) return;
    text(`UPLOADED SCREENSHOT ${i + 1}: "${str(shot.name, 120) || "Screenshot " + (i + 1)}"`);
    blocks.push({ type: "image", source: { type: "base64", media_type: shot.mediaType, data: shot.data } });
    images++;
  });

  if (evidence.html) {
    text(
      "PAGE MARKUP (trimmed; scripts removed). This is what the server received, before any browser scripting ran.\n" +
        str(evidence.html, 70_000)
    );
  }
  if (evidence.css) text("PAGE STYLES (trimmed)\n" + str(evidence.css, 40_000));

  const ds = evidence.designSystem;
  if (ds && (ds.components?.length || ds.styles)) {
    const lines = ["SCALAR DESIGN SYSTEM LIBRARY (published names, read from the library file)"];
    if (ds.components?.length) lines.push("Components: " + ds.components.slice(0, 400).map((n) => str(n, 80)).join("; "));
    for (const [type, names] of Object.entries(ds.styles || {})) {
      lines.push(`${type} styles: ` + names.slice(0, 300).map((n) => str(n, 80)).join("; "));
    }
    text(lines.join("\n"));
  }

  if (!images && !evidence.html && !screens.some((s) => s.outline)) return null;

  // Cache everything above for the other templates run on this prototype.
  blocks[blocks.length - 1].cache_control = { type: "ephemeral" };

  text(buildTemplatePrompt(template, language));
  return blocks;
}
