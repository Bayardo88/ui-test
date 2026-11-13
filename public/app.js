import { TEMPLATES, BUNDLES, SEVERITY } from "./templates.js";
import {
  RESULT_LABELS, linkType, createStreamParser, finalizeSection, errorSection, severityCounts,
  topFixes, overallVerdict, formatDate, toMarkdown, slug,
} from "./lib.js";

const MAX_SHOTS = 6;
const MAX_UPLOAD_CHARS = 3_600_000; // base64 characters across all screenshots
const IMAGE_LONG_EDGE = 1568;
const HISTORY_KEY = "sut.history";
const PREFS_KEY = "sut.prefs";
const MAX_HISTORY = 15;
const PARALLEL = 3;

const $ = (id) => document.getElementById(id);

/** Tiny DOM builder. Text is always set as text, never parsed as HTML. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};

const state = {
  config: { aiConfigured: true, figmaConfigured: true, passcodeRequired: false, model: "" },
  shots: [], // { name, mediaType, data, thumb }
  selected: new Set(),
  running: false,
  abort: null,
  lastRun: null, // { evidence, shots, context, language } kept in memory for retries
  report: null,
  filter: 0,
};

// ---------- setup ----------

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    if (res.ok) state.config = await res.json();
  } catch {}
  $("passcode-wrap").hidden = !state.config.passcodeRequired;
  const banner = $("setup-banner");
  if (!state.config.aiConfigured) {
    banner.replaceChildren(
      h("strong", { text: "Setup needed. " }),
      "Add ",
      h("code", { text: "ANTHROPIC_API_KEY" }),
      " in this site's environment variables in Netlify and redeploy. Tests cannot run until then."
    );
    banner.hidden = false;
  }
}

function renderTests() {
  $("bundles").replaceChildren(
    ...BUNDLES.map((b) =>
      h("button", {
        type: "button", class: "chip", "aria-pressed": "false", dataset: { bundle: b.id },
        title: b.templates.join(", "), text: b.name,
        onclick: () => {
          state.selected = new Set(b.templates);
          syncTests();
        },
      })
    ),
    h("button", {
      type: "button", class: "chip", text: "Clear",
      onclick: () => {
        state.selected.clear();
        syncTests();
      },
    })
  );
  $("tests").replaceChildren(
    ...TEMPLATES.map((t) =>
      h("label", { class: "test" },
        h("input", {
          type: "checkbox", value: t.id,
          onchange: (e) => {
            e.target.checked ? state.selected.add(t.id) : state.selected.delete(t.id);
            syncTests();
          },
        }),
        h("span", { class: "test-name" }, h("span", { class: "test-id", text: t.id }), t.name),
        h("span", { class: "test-summary", text: t.summary })
      )
    )
  );
  syncTests();
}

function syncTests() {
  for (const box of $("tests").querySelectorAll("input")) box.checked = state.selected.has(box.value);
  for (const chip of $("bundles").querySelectorAll("[data-bundle]")) {
    const b = BUNDLES.find((x) => x.id === chip.dataset.bundle);
    const same = b.templates.length === state.selected.size && b.templates.every((id) => state.selected.has(id));
    chip.setAttribute("aria-pressed", String(same));
  }
  const n = state.selected.size;
  $("test-count").textContent = n ? `${n} selected` : "None selected";
  const needsTask = state.selected.has("T11") && !$("task").value.trim();
  $("task-flag").classList.toggle("needed", needsTask);
  savePrefs();
}

function savePrefs() {
  store.set(PREFS_KEY, {
    selected: [...state.selected],
    language: $("language").value,
    viewport: $("viewport").value,
    passcode: $("passcode").value,
  });
}

function loadPrefs() {
  const p = store.get(PREFS_KEY, null);
  const valid = new Set(TEMPLATES.map((t) => t.id));
  state.selected = new Set((p?.selected || ["T1", "T8"]).filter((id) => valid.has(id)));
  $("language").value = p?.language || ((navigator.language || "").toLowerCase().startsWith("es") ? "es" : "en");
  if (p?.viewport) $("viewport").value = p.viewport;
  if (p?.passcode) $("passcode").value = p.passcode;
}

function updateUrlHint() {
  const hint = $("url-hint");
  const value = $("url").value.trim();
  const type = value ? linkType(value) : null;
  hint.classList.toggle("detected", Boolean(type));
  if (!value) hint.textContent = "A Figma design or prototype link, or a public page. One prototype per run.";
  else if (type === "figma") {
    hint.textContent = state.config.figmaConfigured
      ? "Figma link. Its frames will be rendered and their layers read. Link to a frame or section to choose what is tested."
      : "Figma link, but no Figma token is set in Netlify yet (FIGMA_TOKEN). Add it, or upload screenshots instead.";
  } else if (type === "web") {
    hint.textContent = "Live page. Its markup and styles will be read without a browser; add screenshots so layout can be judged.";
  } else hint.textContent = "That does not look like a link yet. It should start with https://";
}

// ---------- screenshots ----------

async function fileToShot(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const hgt = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, hgt);
  ctx.drawImage(bitmap, 0, 0, w, hgt);
  bitmap.close?.();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
  return {
    name: file.name.replace(/\.[a-z0-9]+$/i, "") || "Screenshot",
    mediaType: "image/jpeg",
    data: dataUrl.slice(dataUrl.indexOf(",") + 1),
    thumb: dataUrl,
  };
}

async function addFiles(files) {
  const images = [...files].filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
  if (!images.length) return showFormError("Screenshots must be PNG, JPG or WebP images.");
  clearFormError();
  for (const file of images) {
    if (state.shots.length >= MAX_SHOTS) {
      showFormError(`Up to ${MAX_SHOTS} screenshots per run. The rest were not added.`);
      break;
    }
    try {
      const shot = await fileToShot(file);
      const total = state.shots.reduce((n, s) => n + s.data.length, 0) + shot.data.length;
      if (total > MAX_UPLOAD_CHARS) {
        showFormError("These screenshots are too large together. The rest were not added.");
        break;
      }
      state.shots.push(shot);
    } catch {
      showFormError(`"${file.name}" could not be read as an image.`);
    }
  }
  renderShots();
}

function renderShots() {
  $("shots").replaceChildren(
    ...state.shots.map((s, i) =>
      h("li", { class: "shot" },
        h("img", { src: s.thumb, alt: "" }),
        h("span", { class: "shot-name", text: s.name }),
        h("button", {
          type: "button", "aria-label": `Remove ${s.name}`, text: "×",
          onclick: () => {
            state.shots.splice(i, 1);
            renderShots();
          },
        })
      )
    )
  );
  $("shots-button").textContent = state.shots.length ? "Add more" : "Add screenshots";
}

// ---------- running ----------

function showFormError(msg) {
  const el = $("form-error");
  el.textContent = msg;
  el.hidden = false;
}
function clearFormError() {
  $("form-error").hidden = true;
  $("url").removeAttribute("aria-invalid");
}

function headers() {
  const out = { "content-type": "application/json" };
  const code = $("passcode").value.trim();
  if (code) out["x-app-passcode"] = code;
  return out;
}

async function readError(res) {
  try {
    const body = await res.json();
    return { message: body.error || `Request failed (${res.status}).`, code: body.code };
  } catch {
    return { message: `Request failed (${res.status}).` };
  }
}

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Stopped", "AbortError"));
    });
  });

async function analyze(templateId, run, onProgress, signal) {
  const payload = JSON.stringify({
    templateId,
    language: run.language,
    evidence: run.evidence,
    screenshots: run.shots.map(({ name, mediaType, data }) => ({ name, mediaType, data })),
    context: run.context,
  });
  const delays = [8000, 20000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("/api/analyze", { method: "POST", headers: headers(), body: payload, signal });
    if (!res.ok) {
      const err = await readError(res);
      if ((res.status === 429 || res.status === 503) && attempt < delays.length) {
        onProgress(`Busy, retrying in ${delays[attempt] / 1000} s`);
        await wait(delays[attempt], signal);
        continue;
      }
      const e = new Error(err.message);
      e.code = err.code;
      throw e;
    }
    const parser = createStreamParser();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    onProgress("Reviewing");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      const n = parser.state.issueCount;
      onProgress(n ? `Writing up, ${n} ${n === 1 ? "issue" : "issues"} so far` : "Reviewing");
    }
    return finalizeSection(templateId, parser.finish());
  }
}

function setRunning(on) {
  state.running = on;
  $("run").disabled = on;
  $("run").textContent = on ? "Running…" : "Run tests";
  $("stop").hidden = !on;
}

function buildRunPanel(steps) {
  const rows = {};
  const list = h("div", { class: "run-steps" });
  for (const s of steps) {
    const status = h("span", { class: "s-status", text: "Waiting" });
    const row = h("div", { class: "run-step", dataset: { state: "waiting" } },
      h("span", { class: "dot", "aria-hidden": "true" }),
      h("span", { class: "s-name", text: s.label }),
      status
    );
    rows[s.id] = { row, status };
    list.append(row);
  }
  const panel = $("run-panel");
  panel.replaceChildren(h("div", { class: "card" }, h("h3", { class: "block", text: "Running tests" }), list));
  panel.hidden = false;
  return (id, stateName, text) => {
    const r = rows[id];
    if (!r) return;
    r.row.dataset.state = stateName;
    if (text != null) r.status.textContent = text;
  };
}

async function run(e) {
  e?.preventDefault();
  if (state.running) return;
  clearFormError();

  const url = $("url").value.trim();
  const type = url ? linkType(url) : null;
  const ids = TEMPLATES.map((t) => t.id).filter((id) => state.selected.has(id));
  if (url && !type) {
    $("url").setAttribute("aria-invalid", "true");
    $("url").focus();
    return showFormError("The prototype link is not a valid link. It should start with https://");
  }
  if (!url && !state.shots.length) {
    $("url").focus();
    return showFormError("Paste a prototype link or add screenshots.");
  }
  if (!ids.length) return showFormError("Pick at least one test.");
  if (state.config.passcodeRequired && !$("passcode").value.trim()) {
    $("passcode").focus();
    return showFormError("Enter the access code at the top of the page.");
  }
  savePrefs();

  const context = {
    url,
    task: $("task").value.trim(),
    viewport: $("viewport").value,
    notes: $("notes").value.trim(),
  };
  const language = $("language").value;
  const shots = state.shots.slice();

  state.abort = new AbortController();
  const signal = state.abort.signal;
  setRunning(true);
  $("empty").hidden = true;
  $("report-body").replaceChildren();
  state.filter = 0;

  const steps = [];
  if (url) steps.push({ id: "gather", label: type === "figma" ? "Reading the Figma file" : "Reading the page" });
  for (const id of ids) steps.push({ id, label: `${id} ${TEMPLATES.find((t) => t.id === id).name}` });
  const setStep = buildRunPanel(steps);
  $("report").focus({ preventScroll: true });

  const warnings = [];
  let evidence = null;

  try {
    if (url) {
      setStep("gather", "running", "Working");
      const res = await fetch("/api/gather", { method: "POST", headers: headers(), body: JSON.stringify({ url }), signal });
      if (res.ok) {
        evidence = (await res.json()).evidence;
        const n = evidence.screens?.length || 0;
        setStep("gather", "done", evidence.kind === "figma" ? `${n} ${n === 1 ? "frame" : "frames"} read` : "Markup and styles read");
      } else {
        const err = await readError(res);
        if (err.code === "passcode") throw new Error(err.message);
        if (!shots.length) throw new Error(err.message);
        setStep("gather", "error", "Could not be read");
        warnings.push(`The link could not be read (${err.message}) so this run used the screenshots only.`);
      }
    }
    if (!evidence) {
      evidence = { kind: "screenshots", title: "", method: "Uploaded screenshots", screens: [], notes: [], warnings: [] };
    } else if (shots.length) {
      evidence.method += " plus uploaded screenshots";
    }
    warnings.push(...(evidence.warnings || []));
    if (evidence.kind !== "figma" && !shots.length) {
      warnings.push("No screenshots were provided, so visual checks (layout, hierarchy, rendered contrast) rest on markup and styles alone.");
    }

    const name = $("proto-name").value.trim() || evidence.title || (url ? new URL(url).hostname : "Screenshots");
    evidence.title = name;

    const report = {
      id: `${Date.now()}`,
      createdAt: new Date().toISOString(),
      language,
      model: state.config.model,
      prototype: {
        name,
        url,
        method: evidence.method,
        viewport: context.viewport,
        task: context.task,
        screens: [...(evidence.screens || []).map((s) => s.name), ...shots.map((s) => s.name)],
      },
      warnings,
      sections: [],
    };
    state.report = report;
    state.lastRun = { reportId: report.id, evidence, shots, context, language };

    const runOne = async (id) => {
      const template = TEMPLATES.find((t) => t.id === id);
      if (template.needsTask && !state.lastRun.context.task) {
        // No point paying for a run that cannot be done: ask for the task instead.
        const skipped = errorSection(id, "This test walks through one user task. Add a primary user task under “Context for the reviewer”, then choose Run again.");
        skipped.status = "done";
        skipped.result = "not_run";
        setStep(id, "done", "Needs a task");
        placeSection(report, skipped, ids);
        renderReport(report, { live: true });
        return;
      }
      setStep(id, "running", "Starting");
      try {
        const section = await analyze(id, state.lastRun, (t) => setStep(id, "running", t), signal);
        const n = section.issues.length;
        setStep(id, "done", `${RESULT_LABELS[section.result]}, ${n} ${n === 1 ? "issue" : "issues"}`);
        placeSection(report, section, ids);
      } catch (err) {
        if (err.name === "AbortError") throw err;
        setStep(id, "error", "Could not run");
        placeSection(report, errorSection(id, err.message), ids);
        if (err.code === "passcode" || err.code === "api_key" || err.code === "model") throw err;
      }
      renderReport(report, { live: true });
    };

    // The first test runs alone so the evidence is cached for the others.
    const queue = ids.slice();
    await runOne(queue.shift());
    const workers = Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      while (queue.length) await runOne(queue.shift());
    });
    await Promise.all(workers);

    finishRun(report);
  } catch (err) {
    if (err.name === "AbortError") {
      if (state.report?.sections.length) finishRun(state.report, "Stopped. The tests that finished are below.");
      else resetToEmpty("Stopped before any test finished.");
    } else if (state.report?.sections.some((s) => s.status === "done")) {
      finishRun(state.report, err.message);
    } else {
      resetToEmpty(err.message);
      if (err.code === "passcode") $("passcode").focus();
    }
  } finally {
    setRunning(false);
    state.abort = null;
  }
}

function placeSection(report, section, order) {
  const at = report.sections.findIndex((s) => s.templateId === section.templateId);
  if (at !== -1) report.sections[at] = section;
  else report.sections.push(section);
  report.sections.sort((a, b) => order.indexOf(a.templateId) - order.indexOf(b.templateId));
}

function finishRun(report, message) {
  $("run-panel").hidden = true;
  renderReport(report, { live: false, message });
  saveToHistory(report);
}

function resetToEmpty(message) {
  $("run-panel").hidden = true;
  $("report-body").replaceChildren();
  $("empty").hidden = false;
  state.report = null;
  if (message) showFormError(message);
}

async function retry(templateId) {
  const report = state.report;
  const runCtx = state.lastRun;
  if (!report || !runCtx || runCtx.reportId !== report.id || state.running) return;
  const template = TEMPLATES.find((t) => t.id === templateId);
  if (template.needsTask && !$("task").value.trim() && !runCtx.context.task) {
    document.querySelector(".more").open = true;
    $("task").focus();
    return showFormError("Add the primary user task first, then choose Run again.");
  }
  clearFormError();
  state.abort = new AbortController();
  setRunning(true);
  const order = report.sections.map((s) => s.templateId);
  const setStep = buildRunPanel([{ id: templateId, label: `${templateId} ${TEMPLATES.find((t) => t.id === templateId).name}` }]);
  runCtx.context.task = $("task").value.trim() || runCtx.context.task;
  report.prototype.task = runCtx.context.task;
  try {
    setStep(templateId, "running", "Starting");
    const section = await analyze(templateId, runCtx, (t) => setStep(templateId, "running", t), state.abort.signal);
    placeSection(report, section, order);
  } catch (err) {
    if (err.name !== "AbortError") placeSection(report, errorSection(templateId, err.message), order);
  } finally {
    setRunning(false);
    state.abort = null;
    finishRun(report);
  }
}

// ---------- report rendering ----------

function sevBadge(sev, count) {
  return h("span", { class: `badge sev-${sev}` },
    count != null ? h("span", { class: "n", text: String(count) }) : h("span", { class: "n", text: String(sev) }),
    SEVERITY[sev].label
  );
}

function resultBadge(result) {
  return h("span", { class: `badge res-${result}`, text: RESULT_LABELS[result] || result });
}

function renderReport(report, { live = false, message = "" } = {}) {
  const body = $("report-body");
  const p = report.prototype;
  const v = overallVerdict(report);
  const canRetry = !live && state.lastRun?.reportId === report.id;
  const parts = [];

  // Header card
  const head = h("div", { class: "card report-head" });
  head.append(
    h("div", { class: "report-title" },
      h("div", {}, h("div", { class: "eyebrow", text: "UI test report" }), h("h2", { text: p.name })),
      live
        ? null
        : h("div", { class: "actions" },
            h("button", { type: "button", class: "btn btn-secondary btn-small", text: "Download Markdown", onclick: () => downloadMarkdown(report) }),
            h("button", { type: "button", class: "btn btn-secondary btn-small", text: "Copy", onclick: () => copyMarkdown(report) }),
            h("button", { type: "button", class: "btn btn-secondary btn-small", text: "Print or save PDF", onclick: () => window.print() })
          )
    )
  );
  const meta = h("dl", { class: "meta" });
  const addMeta = (k, val) => val && meta.append(h("div", {}, h("dt", { text: k }), h("dd", {}, val)));
  addMeta("Link", p.url ? h("a", { href: p.url, target: "_blank", rel: "noopener noreferrer", text: p.url.length > 70 ? p.url.slice(0, 70) + "…" : p.url }) : null);
  addMeta("Date", formatDate(report.createdAt));
  addMeta("Inspected as", p.method);
  addMeta("Viewport", p.viewport);
  addMeta("Screens", p.screens?.length ? p.screens.join(", ") : null);
  addMeta("Primary task", p.task);
  head.append(meta);

  if (message) head.append(h("div", { class: "notice", role: "status" }, message));

  head.append(
    h("div", { class: "verdict" },
      h("strong", { text: live ? "Running…" : v.headline }),
      h("div", { class: "tally" }, [4, 3, 2, 1].map((s) => sevBadge(s, v.counts[s])))
    )
  );

  if (report.warnings?.length) {
    head.append(
      h("div", { class: "notice" },
        h("div", { class: "notice-title", text: "Limits of this run" }),
        h("ul", {}, report.warnings.map((w) => h("li", { text: w })))
      )
    );
  }

  // Summary table
  const rows = report.sections.map((s) => {
    const c = severityCounts(s.issues);
    return h("tr", {},
      h("td", {}, h("a", { href: `#sec-${s.templateId}` }, h("span", { class: "id", text: s.templateId }), " ", s.name)),
      [4, 3, 2, 1].map((n) => h("td", { class: "num" + (c[n] ? "" : " zero"), text: String(c[n]) })),
      h("td", {}, resultBadge(s.result))
    );
  });
  head.append(
    h("div", {},
      h("h3", { class: "block", text: "Results by test" }),
      h("div", { class: "table-wrap" },
        h("table", {},
          h("thead", {}, h("tr", {},
            h("th", { scope: "col", text: "Test" }),
            ["Critical", "Major", "Minor", "Cosmetic"].map((t) => h("th", { scope: "col", class: "num", text: t })),
            h("th", { scope: "col", text: "Result" })
          )),
          h("tbody", {}, rows)
        )
      )
    )
  );

  const top = topFixes(report);
  if (top.length && !live) {
    head.append(
      h("div", {},
        h("h3", { class: "block", text: "Top fixes" }),
        h("ol", { class: "top-fixes" },
          top.map((i) =>
            h("li", {},
              h("div", {},
                h("div", { class: "t" }, h("a", { href: `#issue-${i.id}`, class: "id", text: i.id }), " ", i.title, " ", sevBadge(i.severity)),
                h("div", { class: "f", text: i.fix })
              )
            )
          )
        )
      )
    );
  }

  if (v.total && !live) {
    head.append(
      h("div", { class: "filters", role: "group", "aria-label": "Filter issues by severity" },
        h("span", { class: "hint", text: "Show" }),
        [0, 4, 3, 2, 1].map((s) =>
          h("button", {
            type: "button", class: "chip", "aria-pressed": String(state.filter === s),
            text: s ? `${SEVERITY[s].label} (${v.counts[s]})` : `All (${v.total})`,
            onclick: () => {
              state.filter = s;
              renderReport(report);
            },
          })
        )
      )
    );
  }
  parts.push(head);

  // One card per test
  for (const s of report.sections) {
    const card = h("div", { class: "card section", id: `sec-${s.templateId}` });
    card.append(
      h("div", { class: "section-head" },
        h("h2", {}, h("span", { class: "id", text: s.templateId }), s.name),
        h("div", { class: "actions" },
          resultBadge(s.result),
          (s.status === "error" || s.result === "not_run") && canRetry
            ? h("button", { type: "button", class: "btn btn-secondary btn-small retry", text: "Run again", onclick: () => retry(s.templateId) })
            : null
        )
      ),
      h("p", { class: "rationale", text: s.rationale })
    );

    if (s.issues.length) {
      const visible = s.issues.filter((i) => !state.filter || i.severity === state.filter);
      card.append(
        h("div", { class: "table-wrap" },
          h("table", {},
            h("thead", {}, h("tr", {},
              ["ID", "Issue", "Where", "Severity", "Effort"].map((t) => h("th", { scope: "col", text: t }))
            )),
            h("tbody", {},
              visible.map((i) =>
                h("tr", {},
                  h("td", {}, h("a", { href: `#issue-${i.id}`, class: "id", text: i.id })),
                  h("td", { text: i.title }),
                  h("td", { text: i.where }),
                  h("td", {}, sevBadge(i.severity)),
                  h("td", { text: i.effort })
                )
              )
            )
          )
        )
      );
      if (!visible.length) card.append(h("p", { class: "hint", text: "No issues at this severity in this test." }));
      card.append(
        h("div", { class: "issues" },
          s.issues.map((i) =>
            h("article", { class: `issue s${i.severity}`, id: `issue-${i.id}`, hidden: Boolean(state.filter) && i.severity !== state.filter },
              h("div", { class: "issue-head" },
                h("span", { class: "id", text: i.id }),
                h("h4", { text: i.title }),
                sevBadge(i.severity)
              ),
              h("div", { class: "issue-where", text: i.where }),
              h("dl", {},
                h("dt", { text: "What is wrong" }), h("dd", { text: i.problem }),
                h("dt", { text: "Why it matters" }), h("dd", { text: i.why }),
                h("dt", { text: "Guideline" }), h("dd", { text: i.guideline }),
                h("dt", { text: "Fix" }), h("dd", { class: "fix", text: i.fix })
              ),
              h("div", { class: "issue-foot" },
                h("span", { text: `Effort ${i.effort}` }),
                h("span", { text: `Confidence ${i.confidence}` })
              )
            )
          )
        )
      );
    }

    const extra = h("div", { class: "subgrid" });
    if (s.worksWell.length) {
      extra.append(h("div", {}, h("h3", { class: "block", text: "What works well" }), h("ul", { class: "plain-list" }, s.worksWell.map((w) => h("li", { text: w })))));
    }
    if (s.notVerifiable.length) {
      extra.append(h("div", {}, h("h3", { class: "block", text: "Not verifiable in this prototype" }), h("ul", { class: "plain-list" }, s.notVerifiable.map((w) => h("li", { text: w })))));
    }
    if (extra.children.length) card.append(extra);
    parts.push(card);
  }

  if (!live && report.sections.length) {
    parts.push(
      h("p", {
        class: "footnote",
        text: "This is an expert inspection run by an AI reviewer, not a usability test. It predicts problems; it does not prove users will hit them. Validate the important findings with real users.",
      })
    );
  }

  body.replaceChildren(...parts);
}

// ---------- export ----------

function toast(text) {
  const el = h("div", { class: "toast", role: "status", text });
  document.body.append(el);
  setTimeout(() => el.remove(), 2200);
}

function downloadMarkdown(report) {
  const blob = new Blob([toMarkdown(report)], { type: "text/markdown;charset=utf-8" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `ui-test-${slug(report.prototype.name)}-${report.createdAt.slice(0, 10)}.md` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function copyMarkdown(report) {
  try {
    await navigator.clipboard.writeText(toMarkdown(report));
    toast("Report copied as Markdown");
  } catch {
    toast("Copying is blocked here. Use Download instead.");
  }
}

// ---------- history ----------

function saveToHistory(report) {
  if (!report.sections.some((s) => s.status === "done")) return;
  let list = store.get(HISTORY_KEY, []).filter((r) => r.id !== report.id);
  list.unshift(report);
  list = list.slice(0, MAX_HISTORY);
  while (list.length && !store.set(HISTORY_KEY, list)) list.pop();
  renderHistory();
}

function renderHistory() {
  const list = store.get(HISTORY_KEY, []);
  $("history-panel").hidden = !list.length;
  $("history").replaceChildren(
    ...list.map((r) => {
      const v = overallVerdict(r);
      return h("li", {},
        h("button", {
          type: "button", class: "open",
          onclick: () => {
            if (state.running) return;
            state.report = r;
            state.filter = 0;
            $("empty").hidden = true;
            $("run-panel").hidden = true;
            renderReport(r);
            $("report").focus({ preventScroll: true });
            $("report").scrollIntoView({ behavior: "smooth", block: "start" });
          },
        },
          h("span", { class: "h-name", text: r.prototype.name }),
          h("span", { class: "h-meta", text: `${formatDate(r.createdAt)} · ${r.sections.length} ${r.sections.length === 1 ? "test" : "tests"} · ${v.total} ${v.total === 1 ? "issue" : "issues"}` })
        ),
        h("button", {
          type: "button", class: "remove", "aria-label": `Delete report for ${r.prototype.name}`, text: "×",
          onclick: () => {
            store.set(HISTORY_KEY, store.get(HISTORY_KEY, []).filter((x) => x.id !== r.id));
            renderHistory();
          },
        })
      );
    })
  );
}

// ---------- wiring ----------

function init() {
  loadPrefs();
  renderTests();
  renderHistory();
  updateUrlHint();
  loadConfig().then(updateUrlHint);

  $("setup-form").addEventListener("submit", run);
  $("stop").addEventListener("click", () => state.abort?.abort());
  $("url").addEventListener("input", () => {
    clearFormError();
    updateUrlHint();
  });
  $("task").addEventListener("input", syncTests);
  for (const id of ["language", "viewport", "passcode"]) $(id).addEventListener("change", savePrefs);

  const input = $("shots-input");
  $("shots-button").addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    addFiles(input.files);
    input.value = "";
  });
  const zone = $("dropzone");
  for (const ev of ["dragenter", "dragover"]) {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add("over");
    });
  }
  for (const ev of ["dragleave", "drop"]) {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove("over");
    });
  }
  zone.addEventListener("drop", (e) => e.dataTransfer?.files?.length && addFiles(e.dataTransfer.files));
  document.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.some((f) => f.type.startsWith("image/"))) addFiles(files);
  });
}

init();
