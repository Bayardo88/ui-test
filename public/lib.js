// Pure helpers: stream parsing, report assembly, Markdown export.
// No DOM access here, so the same code runs in the browser and in tests.

import { TEMPLATES, SEVERITY } from "./templates.js";

export const RESULT_LABELS = {
  pass: "Pass",
  pass_with_issues: "Pass with issues",
  fail: "Fail",
  not_applicable: "Not applicable",
  not_run: "Not run",
  error: "Could not run",
};

export function linkType(url) {
  try {
    const u = new URL(url.trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    return /(^|\.)figma\.com$/i.test(u.hostname) ? "figma" : "web";
  } catch {
    return null;
  }
}

/**
 * Parser for the Claude API event stream. Feed it text chunks as they arrive;
 * it collects the JSON arguments of the submit_report tool call.
 */
export function createStreamParser() {
  let buffer = "";
  const state = { json: "", stopReason: null, usage: null, error: null, issueCount: 0 };

  function handle(data) {
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
      state.json += ev.delta.partial_json || "";
      state.issueCount = (state.json.match(/"title"\s*:/g) || []).length;
    } else if (ev.type === "message_start") {
      state.usage = { ...(ev.message?.usage || {}) };
    } else if (ev.type === "message_delta") {
      if (ev.delta?.stop_reason) state.stopReason = ev.delta.stop_reason;
      if (ev.usage) state.usage = { ...(state.usage || {}), ...ev.usage };
    } else if (ev.type === "error") {
      state.error = ev.error?.message || "The AI stopped unexpectedly.";
    }
  }

  return {
    state,
    feed(chunk) {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data:")) handle(line.slice(5).trim());
      }
    },
    finish() {
      if (buffer.startsWith("data:")) handle(buffer.slice(5).trim());
      buffer = "";
      if (state.error) throw new Error(state.error);
      if (state.stopReason === "max_tokens") {
        throw new Error("The report was cut off because it got too long. Run this test on fewer screens.");
      }
      if (!state.json) throw new Error("The AI returned an empty report. Try again.");
      try {
        return JSON.parse(state.json);
      } catch {
        throw new Error("The report arrived incomplete. Try again.");
      }
    },
  };
}

const EFFORT_ORDER = { S: 0, M: 1, L: 2 };
const CONF_ORDER = { High: 0, Medium: 1, Low: 2 };

export function computeResult(issues, modelResult) {
  if (modelResult === "not_applicable" || modelResult === "not_run") return modelResult;
  const sev4 = issues.filter((i) => i.severity === 4).length;
  const sev3 = issues.filter((i) => i.severity === 3).length;
  const sev2 = issues.filter((i) => i.severity === 2).length;
  if (sev4 > 0 || sev3 >= 3) return "fail";
  if (sev3 > 0 || sev2 > 0) return "pass_with_issues";
  return "pass";
}

const text = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const list = (v) => (Array.isArray(v) ? v.map(text).filter(Boolean) : []);

/** Turn the model's raw tool output into a clean report section. */
export function finalizeSection(templateId, raw) {
  const template = TEMPLATES.find((t) => t.id === templateId);
  const issues = (Array.isArray(raw?.issues) ? raw.issues : [])
    .map((i) => ({
      title: text(i.title),
      where: text(i.where),
      problem: text(i.problem),
      why: text(i.why),
      guideline: text(i.guideline),
      fix: text(i.fix),
      severity: [1, 2, 3, 4].includes(Number(i.severity)) ? Number(i.severity) : 2,
      effort: ["S", "M", "L"].includes(i.effort) ? i.effort : "M",
      confidence: ["High", "Medium", "Low"].includes(i.confidence) ? i.confidence : "Medium",
    }))
    .filter((i) => i.title)
    .sort((a, b) => b.severity - a.severity || EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort]);
  issues.forEach((issue, n) => {
    issue.id = `${templateId}-${String(n + 1).padStart(2, "0")}`;
  });
  return {
    templateId,
    name: template ? template.name : templateId,
    status: "done",
    result: computeResult(issues, raw?.result),
    rationale: text(raw?.rationale),
    issues,
    worksWell: list(raw?.works_well),
    notVerifiable: list(raw?.not_verifiable),
  };
}

export function errorSection(templateId, message) {
  const template = TEMPLATES.find((t) => t.id === templateId);
  return {
    templateId,
    name: template ? template.name : templateId,
    status: "error",
    result: "error",
    rationale: message,
    issues: [],
    worksWell: [],
    notVerifiable: [],
  };
}

export function severityCounts(issues) {
  const c = { 4: 0, 3: 0, 2: 0, 1: 0 };
  for (const i of issues) c[i.severity]++;
  return c;
}

export function allIssues(report) {
  return report.sections.flatMap((s) => s.issues.map((i) => ({ ...i, templateName: s.name })));
}

export function topFixes(report, n = 5) {
  return allIssues(report)
    .sort(
      (a, b) =>
        b.severity - a.severity ||
        EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort] ||
        CONF_ORDER[a.confidence] - CONF_ORDER[b.confidence]
    )
    .slice(0, n);
}

export function overallVerdict(report) {
  const done = report.sections.filter((s) => s.status === "done");
  const issues = allIssues(report);
  const c = severityCounts(issues);
  const failed = done.filter((s) => s.result === "fail").length;
  const errors = report.sections.filter((s) => s.status === "error").length;
  let headline;
  if (!done.length) headline = "No test finished";
  else if (failed) headline = `${failed} of ${done.length} tests failed`;
  else if (issues.length) headline = "No test failed, but there are issues to fix";
  else headline = "All tests passed";
  return { headline, counts: c, total: issues.length, failed, errors, tests: done.length };
}

export function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

const md = (s) => String(s || "").replace(/\|/g, "\\|").replace(/\n+/g, " ");

export function toMarkdown(report) {
  const p = report.prototype;
  const v = overallVerdict(report);
  const out = [];
  out.push(`# UI Test Report: ${p.name}`, "");
  if (p.url) out.push(`- **Link:** ${p.url}`);
  out.push(
    `- **Date:** ${formatDate(report.createdAt)}`,
    `- **Viewport:** ${p.viewport}`,
    `- **How it was inspected:** ${p.method}`,
    `- **Tests run:** ${report.sections.map((s) => `${s.templateId} ${s.name}`).join(", ")}`
  );
  if (p.screens?.length) out.push(`- **Screens:** ${p.screens.join(", ")}`);
  if (p.task) out.push(`- **Primary task:** ${p.task}`);
  out.push("", "## Summary", "", `**${v.headline}.** ${v.total} issues: ${v.counts[4]} critical, ${v.counts[3]} major, ${v.counts[2]} minor, ${v.counts[1]} cosmetic.`, "");
  out.push("| Test | Critical | Major | Minor | Cosmetic | Result |", "|---|---|---|---|---|---|");
  for (const s of report.sections) {
    const c = severityCounts(s.issues);
    out.push(`| ${s.templateId} ${md(s.name)} | ${c[4]} | ${c[3]} | ${c[2]} | ${c[1]} | ${RESULT_LABELS[s.result] || s.result} |`);
  }
  const top = topFixes(report);
  if (top.length) {
    out.push("", "### Top fixes", "");
    top.forEach((i, n) => out.push(`${n + 1}. **${i.id} ${i.title}** (${SEVERITY[i.severity].label}, effort ${i.effort}): ${i.fix}`));
  }
  if (report.warnings?.length) {
    out.push("", "### Limits of this run", "");
    report.warnings.forEach((w) => out.push(`- ${w}`));
  }
  for (const s of report.sections) {
    out.push("", `## ${s.templateId} ${s.name}`, "", `**Result: ${RESULT_LABELS[s.result] || s.result}.** ${s.rationale}`);
    if (s.issues.length) {
      out.push("", "| ID | Issue | Where | Severity | Effort |", "|---|---|---|---|---|");
      s.issues.forEach((i) => out.push(`| ${i.id} | ${md(i.title)} | ${md(i.where)} | ${i.severity} ${SEVERITY[i.severity].label} | ${i.effort} |`));
      for (const i of s.issues) {
        out.push(
          "",
          `### ${i.id} ${i.title}`,
          "",
          `- **Where:** ${i.where}`,
          `- **What is wrong:** ${i.problem}`,
          `- **Why it matters:** ${i.why}`,
          `- **Guideline:** ${i.guideline}`,
          `- **Fix:** ${i.fix}`,
          `- **Severity:** ${i.severity} ${SEVERITY[i.severity].label} · **Effort:** ${i.effort} · **Confidence:** ${i.confidence}`
        );
      }
    }
    if (s.worksWell.length) {
      out.push("", "**What works well**", "");
      s.worksWell.forEach((w) => out.push(`- ${w}`));
    }
    if (s.notVerifiable.length) {
      out.push("", "**Not verifiable in this prototype**", "");
      s.notVerifiable.forEach((w) => out.push(`- ${w}`));
    }
  }
  out.push(
    "",
    "---",
    "This is an expert inspection run by an AI reviewer, not a usability test. It predicts problems; it does not prove users will hit them. Validate the important findings with real users."
  );
  return out.join("\n") + "\n";
}

export function slug(s) {
  return (
    String(s || "report")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "report"
  );
}
