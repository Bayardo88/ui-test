// Figma evidence gathering: parse the link, pick the screens, render them,
// and turn each screen's layer tree into a compact outline the reviewer can read.

const API = "https://api.figma.com/v1";
export const MAX_SCREENS = 8;
const MAX_NODES_PER_SCREEN = 450;
const MAX_OUTLINE_CHARS = 26000;
const MAX_DEPTH = 12;
const IMAGE_LONG_EDGE = 1568;
const SCREEN_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION"]);

export function parseFigmaUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/(^|\.)figma\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  const kind = parts[0];
  if (!["design", "file", "proto", "make", "board", "slides"].includes(kind)) return null;
  let fileKey = parts[1];
  if (!fileKey) return null;
  const branchAt = parts.indexOf("branch");
  if (branchAt !== -1 && parts[branchAt + 1]) fileKey = parts[branchAt + 1];
  const rawNode =
    u.searchParams.get("node-id") || u.searchParams.get("starting-point-node-id") || "";
  const nodeId = rawNode ? decodeURIComponent(rawNode).replace(/-/g, ":") : null;
  return { kind, fileKey, nodeId };
}

async function figmaGet(path, token, fetchImpl) {
  const res = await fetchImpl(API + path, { headers: { "X-Figma-Token": token } });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.err || body.message || "";
    } catch {}
    const err = new Error(figmaErrorMessage(res.status, detail));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function figmaErrorMessage(status, detail) {
  if (status === 403)
    return "Figma refused access to this file. The Figma token set in Netlify must belong to an account that can view it.";
  if (status === 404) return "Figma could not find this file or frame. Check the link.";
  if (status === 429) return "Figma is rate-limiting requests. Wait a minute and try again.";
  return `Figma returned an error (${status})${detail ? ": " + detail : ""}.`;
}

// ---------- colour helpers ----------

function solidFill(node) {
  const fills = Array.isArray(node.fills) ? node.fills : [];
  for (let i = fills.length - 1; i >= 0; i--) {
    const f = fills[i];
    if (f && f.visible !== false && f.type === "SOLID" && f.color) {
      const a = (f.opacity ?? 1) * (f.color.a ?? 1);
      return { r: f.color.r, g: f.color.g, b: f.color.b, a };
    }
  }
  return null;
}

function hasNonSolidFill(node) {
  const fills = Array.isArray(node.fills) ? node.fills : [];
  return fills.some((f) => f && f.visible !== false && f.type !== "SOLID");
}

export function toHex(c) {
  const h = (v) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return ("#" + h(c.r) + h(c.g) + h(c.b)).toUpperCase();
}

function blend(fg, bg) {
  const a = fg.a ?? 1;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

function luminance(c) {
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

export function contrastRatio(fg, bg) {
  const f = blend(fg, bg);
  const l1 = luminance(f);
  const l2 = luminance(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------- outline ----------

function round(n) {
  return Math.round(n * 10) / 10;
}

function clip(s, n) {
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Turn one screen's node tree into indented lines.
 * dict = { components, componentSets, styles } from the Figma nodes response.
 */
export function buildOutline(root, dict = {}) {
  const components = dict.components || {};
  const componentSets = dict.componentSets || {};
  const styles = dict.styles || {};
  const origin = root.absoluteBoundingBox || { x: 0, y: 0 };
  const lines = [];
  const stats = { nodes: 0, truncated: false, textNodes: 0, lowContrast: 0, rawFills: 0, rawText: 0, instances: 0 };
  let chars = 0;

  function push(line) {
    chars += line.length + 1;
    lines.push(line);
  }

  function walk(node, depth, bg, bgKnown) {
    if (node.visible === false) return;
    if (stats.nodes >= MAX_NODES_PER_SCREEN || chars >= MAX_OUTLINE_CHARS) {
      stats.truncated = true;
      return;
    }
    stats.nodes++;
    const parts = [];
    const box = node.absoluteBoundingBox;
    parts.push(`${node.type} "${clip(node.name || "", 48)}"`);
    if (box) {
      parts.push(
        `[${Math.round(box.x - origin.x)},${Math.round(box.y - origin.y)} ${Math.round(box.width)}x${Math.round(box.height)}]`
      );
    }

    const fill = solidFill(node);
    const nodeStyles = node.styles || {};
    const bound = node.boundVariables || {};
    const fillBinding = nodeStyles.fill || nodeStyles.fills
      ? `style:${clip(styles[nodeStyles.fill || nodeStyles.fills]?.name || "?", 40)}`
      : bound.fills
      ? "variable"
      : "raw";

    if (node.type === "TEXT") {
      stats.textNodes++;
      const st = node.style || {};
      const textBinding = nodeStyles.text
        ? `style:${clip(styles[nodeStyles.text]?.name || "?", 40)}`
        : bound.fontSize || bound.fontFamily || bound.fontStyle
        ? "variable"
        : "raw";
      if (textBinding === "raw") stats.rawText++;
      parts.push(`text="${clip(node.characters || "", 90)}"`);
      if (st.fontSize) {
        parts.push(
          `font=${st.fontFamily || "?"} ${round(st.fontSize)}/${st.lineHeightPx ? round(st.lineHeightPx) : "auto"} w${st.fontWeight || "?"} (${textBinding})`
        );
      }
      if (fill) {
        if (fillBinding === "raw") stats.rawFills++;
        parts.push(`color=${toHex(fill)}${fill.a < 0.99 ? "@" + round(fill.a) : ""} (${fillBinding})`);
        if (bgKnown && bg) {
          const ratio = contrastRatio(fill, bg);
          const size = st.fontSize || 14;
          const large = size >= 24 || (size >= 18.66 && (st.fontWeight || 400) >= 700);
          const min = large ? 3 : 4.5;
          parts.push(`contrast≈${ratio.toFixed(2)}:1 on ${toHex(bg)}${ratio < min ? ` BELOW ${min}:1` : ""}`);
          if (ratio < min) stats.lowContrast++;
        }
      }
    } else {
      if (fill && fill.a > 0.02) {
        if (fillBinding === "raw") stats.rawFills++;
        parts.push(`fill=${toHex(fill)}${fill.a < 0.99 ? "@" + round(fill.a) : ""} (${fillBinding})`);
      } else if (hasNonSolidFill(node)) {
        parts.push("fill=image-or-gradient");
      }
      const stroke = Array.isArray(node.strokes)
        ? node.strokes.find((s) => s && s.visible !== false && s.type === "SOLID" && s.color)
        : null;
      if (stroke && node.strokeWeight) {
        parts.push(`stroke=${toHex(stroke.color)} ${round(node.strokeWeight)}px`);
      }
      if (typeof node.cornerRadius === "number" && node.cornerRadius > 0) {
        parts.push(`radius=${round(node.cornerRadius)}${bound.topLeftRadius || bound.cornerRadius ? "" : " (raw)"}`);
      }
      if (node.layoutMode && node.layoutMode !== "NONE") {
        const pad = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map((p) => p || 0);
        parts.push(
          `layout=${node.layoutMode === "HORIZONTAL" ? "row" : "column"} gap=${node.itemSpacing || 0} pad=${pad.join("/")}`
        );
      }
    }

    if (node.type === "INSTANCE" && node.componentId) {
      stats.instances++;
      const comp = components[node.componentId];
      if (comp) {
        const setName = comp.componentSetId ? componentSets[comp.componentSetId]?.name : null;
        const name = setName ? `${setName} / ${comp.name}` : comp.name;
        parts.push(`comp=${clip(name, 70)} (${comp.remote ? "lib" : "local"})`);
      } else {
        parts.push("comp=? (unresolved)");
      }
    }
    if (typeof node.opacity === "number" && node.opacity < 0.99) parts.push(`opacity=${round(node.opacity)}`);
    if (node.transitionNodeID) parts.push(`onClick→${node.transitionNodeID}`);

    push("  ".repeat(depth) + parts.join(" "));

    // Background for descendants: nearest ancestor with an opaque solid fill.
    let nextBg = bg;
    let nextKnown = bgKnown;
    if (node.type !== "TEXT") {
      if (fill && fill.a >= 0.99) {
        nextBg = { r: fill.r, g: fill.g, b: fill.b, a: 1 };
        nextKnown = true;
      } else if (fill && fill.a > 0.02 && bg) {
        nextBg = blend(fill, bg);
      } else if (hasNonSolidFill(node)) {
        nextKnown = false;
      }
    }

    const kids = Array.isArray(node.children) ? node.children : [];
    if (!kids.length) return;
    if (depth >= MAX_DEPTH) {
      push("  ".repeat(depth + 1) + `… ${kids.length} deeper layers not shown`);
      return;
    }
    for (const kid of kids) walk(kid, depth + 1, nextBg, nextKnown);
  }

  walk(root, 0, { r: 1, g: 1, b: 1, a: 1 }, true);
  if (stats.truncated) push("… outline cut here: this screen has more layers than fit.");
  return { outline: lines.join("\n"), stats };
}

function screenScale(box) {
  const long = Math.max(box?.width || 0, box?.height || 0) || IMAGE_LONG_EDGE;
  return Math.max(0.05, Math.min(1, IMAGE_LONG_EDGE / long));
}

function pickScreens(children) {
  return (children || []).filter((c) => c && c.visible !== false && SCREEN_TYPES.has(c.type) && c.absoluteBoundingBox);
}

/**
 * Collect evidence for a Figma link.
 * opts: { token, sdsFileKey, fetchImpl }
 */
export async function gatherFigma(link, opts) {
  const fetchImpl = opts.fetchImpl || fetch;
  const token = opts.token;
  const { fileKey, nodeId, kind } = link;
  const warnings = [];
  const notes = [];

  if (kind === "board" || kind === "slides" || kind === "make") {
    throw new Error(
      "This link is a FigJam, Slides or Make file. Paste a Figma design or prototype link, or upload screenshots instead."
    );
  }

  // 1. Decide which frames are the screens.
  let fileName = "";
  let candidates = [];
  let skipped = 0;

  if (nodeId) {
    const shallow = await figmaGet(
      `/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=1`,
      token,
      fetchImpl
    );
    fileName = shallow.name || "";
    const entry = shallow.nodes?.[nodeId];
    if (!entry || !entry.document) throw new Error("Figma could not find the frame in this link. Check the node in the URL.");
    const doc = entry.document;
    if (doc.type === "CANVAS" || doc.type === "SECTION") {
      const frames = pickScreens(doc.children);
      candidates = frames.slice(0, MAX_SCREENS);
      skipped = Math.max(0, frames.length - candidates.length);
      notes.push(`The link points at the ${doc.type === "CANVAS" ? "page" : "section"} "${doc.name}".`);
    } else {
      candidates = [doc];
    }
  } else {
    const file = await figmaGet(`/files/${fileKey}?depth=2`, token, fetchImpl);
    fileName = file.name || "";
    const pages = file.document?.children || [];
    const page = pages.find((p) => pickScreens(p.children).length) || pages[0];
    if (!page) throw new Error("This Figma file has no pages with frames.");
    const frames = pickScreens(page.children);
    candidates = frames.slice(0, MAX_SCREENS);
    skipped = Math.max(0, frames.length - candidates.length);
    notes.push(`The link has no frame selected, so the first page with frames was used: "${page.name}".`);
  }

  if (!candidates.length) throw new Error("No frames were found at this link. Link directly to a frame or a page that contains frames.");
  if (skipped) {
    warnings.push(
      `Only the first ${MAX_SCREENS} frames were tested; ${skipped} more were skipped. Link to a specific frame or section to choose which ones.`
    );
  }

  const ids = candidates.map((c) => c.id);

  // 2. Full layer trees, rendered images and the design-system library names, in parallel.
  const treesP = figmaGet(`/files/${fileKey}/nodes?ids=${encodeURIComponent(ids.join(","))}`, token, fetchImpl);
  const imagesP = Promise.all(
    candidates.map(async (c) => {
      const scale = screenScale(c.absoluteBoundingBox);
      try {
        const r = await figmaGet(
          `/images/${fileKey}?ids=${encodeURIComponent(c.id)}&format=png&scale=${scale.toFixed(3)}`,
          token,
          fetchImpl
        );
        return { id: c.id, url: r.images?.[c.id] || null, scale };
      } catch (e) {
        return { id: c.id, url: null, scale, error: e.message };
      }
    })
  );
  const sdsP = opts.sdsFileKey ? gatherLibraryNames(opts.sdsFileKey, token, fetchImpl) : Promise.resolve(null);

  const [trees, images, sds] = await Promise.all([treesP, imagesP, sdsP]);

  const idToName = {};
  for (const c of candidates) idToName[c.id] = c.name;

  const screens = [];
  for (const c of candidates) {
    const entry = trees.nodes?.[c.id];
    if (!entry || !entry.document) continue;
    const { outline, stats } = buildOutline(entry.document, entry);
    const img = images.find((i) => i.id === c.id) || {};
    const box = entry.document.absoluteBoundingBox || {};
    if (!img.url) warnings.push(`Figma could not render "${c.name}"; it will be reviewed from its layer outline only.`);
    if (img.url && img.scale < 0.5) {
      warnings.push(
        `"${c.name}" is very large and was scaled to ${Math.round(img.scale * 100)}% for review; small text may not be legible. Test it in sections for more detail.`
      );
    }
    // Replace prototype link ids with screen names where we know them.
    const linked = outline.replace(/onClick→([0-9:;IA-Za-z]+)/g, (m, id) =>
      idToName[id] ? `onClick→"${idToName[id]}"` : "onClick→(another frame)"
    );
    screens.push({
      id: c.id,
      name: c.name,
      width: Math.round(box.width || 0),
      height: Math.round(box.height || 0),
      imageUrl: img.url || null,
      outline: linked,
      stats,
    });
  }
  if (!screens.length) throw new Error("Figma returned no layer data for these frames.");

  if (sds && sds.error) warnings.push(sds.error);

  return {
    kind: "figma",
    title: fileName || "Figma prototype",
    method: "Figma file (rendered frames and layer outline)",
    screens,
    designSystem: sds && !sds.error ? sds : null,
    notes,
    warnings,
  };
}

async function gatherLibraryNames(fileKey, token, fetchImpl) {
  try {
    const [sets, comps, styles] = await Promise.all([
      figmaGet(`/files/${fileKey}/component_sets`, token, fetchImpl).catch(() => null),
      figmaGet(`/files/${fileKey}/components`, token, fetchImpl),
      figmaGet(`/files/${fileKey}/styles`, token, fetchImpl).catch(() => null),
    ]);
    const names = new Set();
    for (const s of sets?.meta?.component_sets || []) names.add(s.name);
    for (const c of comps?.meta?.components || []) {
      // Variants are named "Prop=Value, …"; the set name already covers them.
      if (!/=/.test(c.name)) names.add(c.name);
      else if (c.containing_frame?.containingStateGroup?.name) names.add(c.containing_frame.containingStateGroup.name);
    }
    const styleNames = {};
    for (const s of styles?.meta?.styles || []) {
      const type = s.style_type || "OTHER";
      (styleNames[type] ||= []).push(s.name);
    }
    return {
      components: [...names].sort().slice(0, 400),
      styles: Object.fromEntries(Object.entries(styleNames).map(([k, v]) => [k, v.sort().slice(0, 300)])),
    };
  } catch (e) {
    return {
      error:
        "The Scalar Design System library could not be read with this Figma token, so the design system test relies on the built-in rules only.",
    };
  }
}
