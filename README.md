# Scalar UI Tester

Paste a prototype link, pick one or more UI test templates, and get a report per test with the issues found and a fix for each. The review is done by Claude through the Claude API.

## What it accepts

| Source | How it is read | What that means |
|---|---|---|
| Figma design or prototype link | Figma API: each frame is rendered to an image and its layer tree is turned into an outline | Contrast, sizes, raw vs bound styles and component use are measured, not guessed |
| Live or staging URL | The server fetches the HTML and stylesheets. No browser runs | Structure, labels and CSS are reviewed. Pages that render in the browser (most single-page apps) or sit behind a login come back empty: add screenshots |
| Screenshots | Up to 6 images, resized in your browser | Works for anything private. Can be combined with a link |

One prototype per run. A Figma link to a page or section tests its first 8 frames; link to a single frame to test just that one.

## The tests

T1 Heuristic evaluation · T2 Scalar Design System compliance · T3 Accessibility (WCAG 2.2 AA) · T4 Data tables and density · T5 Forms and data entry · T6 Navigation and information architecture · T7 Visual hierarchy and layout · T8 System feedback and states · T9 Content and microcopy · T10 Dashboards and data visualization · T11 Task-flow walkthrough (needs a task).

Bundles: Quick scan (T1, T8), Ship check (T2, T3, T8), Data screen (T4, T7, T9), Full audit (all).

Checklists, bundles and the Scalar Design System rules live in one file: `public/templates.js`. Edit it and redeploy.

## Deploy on Netlify

1. In Netlify choose **Add new site → Import an existing project** and pick this repository. Leave the build command empty; the publish directory (`public`) is read from `netlify.toml`.
2. In **Site configuration → Environment variables** add:

| Variable | Required | What it is |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Claude API key from the Claude Console. Every test run is billed to it |
| `APP_PASSCODE` | Strongly recommended | A code people must enter to use the app. Without it, anyone with the URL can spend your API key |
| `FIGMA_TOKEN` | For Figma links | A Figma personal access token from an account that can view the prototypes and the design system library, with read access to file content and library content |
| `ANTHROPIC_MODEL` | No | Model ID to use. Defaults to `claude-sonnet-5-5` |
| `SDS_FIGMA_FILE_KEY` | No | Design system library file. Defaults to the Scalar Design System file |

3. Trigger a deploy (**Deploys → Trigger deploy**) so the variables take effect.

After that, every push to the repository redeploys the site.

## Run it locally

```
node test/smoke.mjs              # offline checks
MOCK=1 node test/dev-server.mjs  # full app with fake Figma and AI responses, http://localhost:8888
npx netlify-cli dev              # the real thing, with a .env file holding the variables above
```

## How it works

- `public/` is the page. No build step, no dependencies.
- `netlify/functions/gather.mjs` (`POST /api/gather`) reads the prototype behind the link.
- `netlify/edge-functions/analyze.js` (`POST /api/analyze`) runs one test template with the Claude API and streams the result. It runs at the edge so a long review is not cut off by a function time limit.
- Each selected test is its own AI call. The first runs alone so the prototype evidence is cached; the rest run three at a time and reuse it.
- Reports are kept in the browser's local storage (last 15). Nothing is stored on the server.

## Limits worth knowing

- This is expert inspection by an AI reviewer, not a usability test. It predicts problems; it does not prove users will hit them.
- Keyboard, focus and screen-reader behaviour cannot be observed in static frames. Those checks are listed as "not verifiable" with what to test in build.
- Contrast values from Figma are computed against the nearest parent fill. The reviewer is told to confirm them against the rendered frame.
- Figma variables (tokens) are not readable through Figma's API on most plans, so token checks rely on whether a layer is bound to a style or variable, plus the library's published component and style names.
- There is no rate limiting beyond the access code.
