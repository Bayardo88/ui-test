// Fake Figma and Claude API responses so the app can be exercised offline.

const solid = (r, g, b, a = 1) => [{ type: "SOLID", color: { r, g, b, a } }];
const text = (id, name, chars, x, y, w, h, color, size = 14, weight = 400, styled = false) => ({
  id, name, type: "TEXT", characters: chars, absoluteBoundingBox: { x, y, width: w, height: h },
  fills: solid(...color), style: { fontFamily: "Inter", fontSize: size, fontWeight: weight, lineHeightPx: size * 1.4 },
  styles: styled ? { text: "S:text1", fill: "S:fill1" } : {},
});

export function frame(id, name) {
  return {
    id, name, type: "FRAME", absoluteBoundingBox: { x: 100, y: 200, width: 1440, height: 900 }, fills: solid(1, 1, 1),
    children: [
      { id: id + ":h", name: "Header", type: "FRAME", layoutMode: "HORIZONTAL", itemSpacing: 12, paddingLeft: 24, paddingRight: 24,
        absoluteBoundingBox: { x: 100, y: 200, width: 1440, height: 56 }, fills: solid(0.063, 0.165, 0.298),
        children: [
          text(id + ":t", "Title", "Portfolio valuations", 124, 218, 200, 20, [1, 1, 1], 16, 600, true),
          { id: id + ":b", name: "Button", type: "INSTANCE", componentId: "C:1", absoluteBoundingBox: { x: 1400, y: 212, width: 96, height: 32 },
            fills: solid(0.12, 0.44, 0.92), transitionNodeID: "2:1",
            children: [text(id + ":bl", "Label", "Export", 1420, 220, 56, 16, [1, 1, 1], 13, 600, true)] },
        ] },
      text(id + ":m", "Muted note", "As of 30 Sep 2026", 124, 280, 200, 16, [0.72, 0.74, 0.78], 12),
      { id: id + ":x", name: "Hidden", type: "FRAME", visible: false, absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } },
      { id: id + ":i", name: "Icon button", type: "FRAME", absoluteBoundingBox: { x: 1500, y: 280, width: 16, height: 16 }, fills: solid(0.9, 0.9, 0.9), cornerRadius: 4 },
    ],
  };
}

const dict = {
  components: { "C:1": { key: "k", name: "Type=Primary, State=Default", remote: true, componentSetId: "CS:1" } },
  componentSets: { "CS:1": { key: "k2", name: "Button" } },
  styles: { "S:text1": { name: "Body/Medium", styleType: "TEXT" }, "S:fill1": { name: "Text/On accent", styleType: "FILL" } },
};

export function figmaMock(url) {
  const u = new URL(url);
  const path = u.pathname.replace("/v1", "");
  const ids = (u.searchParams.get("ids") || "").split(",").filter(Boolean);
  const names = { "1:1": "Valuations list", "2:1": "Valuation detail", "3:1": "Edit valuation" };
  let body;
  if (/\/files\/[^/]+\/nodes$/.test(path)) {
    const nodes = {};
    for (const id of ids) {
      if (id === "0:1") {
        nodes[id] = { document: { id, name: "Flows", type: "CANVAS", children: Object.keys(names).map((k) => frame(k, names[k])) } };
      } else nodes[id] = { document: frame(id, names[id] || "Frame " + id), ...dict };
    }
    body = { name: "Valuation workflow v3", nodes };
  } else if (/\/files\/[^/]+\/(components|component_sets|styles)$/.test(path)) {
    const kind = path.split("/").pop();
    body = { meta: kind === "styles"
      ? { styles: [{ name: "Body/Medium", style_type: "TEXT" }, { name: "Text/On accent", style_type: "FILL" }] }
      : kind === "components" ? { components: [{ name: "Cell" }, { name: "Type=Primary, State=Default", containing_frame: { containingStateGroup: { name: "Button" } } }] }
      : { component_sets: [{ name: "Button" }, { name: "Button_Icon" }, { name: "Column Header" }] } };
  } else if (/\/images\//.test(path)) {
    body = { images: Object.fromEntries(ids.map((id) => [id, `https://figma-mock.example/img/${encodeURIComponent(id)}.png`])) };
  } else if (/\/files\/[^/]+$/.test(path)) {
    body = { name: "Valuation workflow v3", document: { children: [{ id: "0:1", name: "Flows", type: "CANVAS", children: Object.keys(names).map((k) => frame(k, names[k])) }] } };
  } else return new Response(JSON.stringify({ err: "Not found" }), { status: 404 });
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const CANNED = {
  T1: {
    result: "pass_with_issues", rationale: "The flow is coherent, but two status and recovery gaps would slow analysts down.",
    issues: [
      { title: "Active filters are not visible after leaving the list", where: "Valuation detail, header", problem: "The period and fund filters chosen on the list are not shown on the detail screen.", why: "Analysts cannot tell which period a figure belongs to and may read a stale number as current.", guideline: "H1 Visibility of system status", fix: "Show the active fund and period in the page header using the SDS context bar, with a link back to change them.", severity: 3, effort: "M", confidence: "Medium" },
      { title: "No undo after bulk approve", where: "Valuations list, bulk action bar", problem: "Approve applies immediately to all selected rows with no confirmation or undo.", why: "A mis-click approves valuations that then need manual reversal.", guideline: "H3 User control and freedom", fix: "Add an undo toast for 10 seconds after bulk approve, or a confirmation that names the number of rows.", severity: 3, effort: "S", confidence: "Medium" },
      { title: "Export button label is generic", where: "Valuations list, header, Export button", problem: "The label is 'Export' with no format.", why: "Users have to click to learn what they get.", guideline: "H2 Match between system and the real world", fix: "Label it 'Export to Excel' or open a menu with the formats.", severity: 1, effort: "S", confidence: "High" },
    ],
    works_well: ["Column order follows the analyst's reading order: company, method, value, change.", "Primary action is consistently top-right on all three screens."],
    not_verifiable: ["Keyboard shortcuts for power users: not visible in static frames; check in build."],
  },
  T3: {
    result: "fail", rationale: "One measured contrast failure on data text and undersized targets in the table.",
    issues: [
      { title: "As-of date fails text contrast", where: "Valuations list, 'As of 30 Sep 2026' under the header", problem: "12 px text #B8BDC7 on #FFFFFF measures 1.87:1.", why: "The as-of date is what tells users whether numbers are current; low-vision users cannot read it.", guideline: "WCAG 2.2 SC 1.4.3 Contrast (Minimum)", fix: "Use the secondary text style instead of the raw grey; it needs at least 4.5:1 at this size.", severity: 4, effort: "S", confidence: "High" },
      { title: "Icon button is below the minimum target size", where: "Valuations list, 16 x 16 icon button at top right", problem: "The target is 16 by 16 px with no spacing allowance.", why: "Hard to hit for users with tremor and on touch laptops.", guideline: "WCAG 2.2 SC 2.5.8 Target Size (Minimum)", fix: "Use Button_Icon at its 24 px or larger size.", severity: 2, effort: "S", confidence: "High" },
    ],
    works_well: ["Header title on the navy bar measures above 12:1."],
    not_verifiable: ["2.4.7 Focus Visible and 2.4.3 Focus Order: static frames show no focus states; tab through the built page.", "4.1.3 Status Messages: needs a screen reader check in build."],
  },
};

export function claudeMock(bodyText) {
  const req = JSON.parse(bodyText);
  const last = req.messages[0].content.at(-1).text;
  const id = (last.match(/Run this test template now: (T\d+)/) || [])[1];
  const report = CANNED[id] || { result: id === "T10" ? "not_applicable" : "pass", rationale: id === "T10" ? "There are no charts or KPI tiles on these screens." : "Nothing on these screens breaks this checklist.", issues: [], works_well: ["Consistent spacing rhythm across the three screens."], not_verifiable: [] };
  const jsonText = JSON.stringify(report);
  const events = [];
  const ev = (type, data) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("message_start", { message: { usage: { input_tokens: 4200 } } });
  ev("content_block_start", { index: 0, content_block: { type: "tool_use", name: "submit_report", input: {} } });
  for (let i = 0; i < jsonText.length; i += 37) ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: jsonText.slice(i, i + 37) } });
  ev("content_block_stop", { index: 0 });
  ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 900 } });
  ev("message_stop", {});
  const enc = new TextEncoder();
  const delay = Number(process.env.MOCK_DELAY_MS || 15);
  const stream = new ReadableStream({
    async start(ctrl) {
      for (const e of events) {
        // Split mid-event on purpose to exercise the parser's buffering.
        const cut = Math.floor(e.length / 2);
        ctrl.enqueue(enc.encode(e.slice(0, cut)));
        await new Promise((r) => setTimeout(r, delay));
        ctrl.enqueue(enc.encode(e.slice(cut)));
      }
      ctrl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}
