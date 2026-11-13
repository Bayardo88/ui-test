// Local preview without Netlify: `node test/dev-server.mjs`
// MOCK=1 fakes Figma and the Claude API so no keys or network are needed.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { figmaMock, claudeMock } from "./mocks.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8888);
globalThis.Netlify = { env: { get: (k) => process.env[k] || "" } };

if (process.env.MOCK) {
  process.env.ANTHROPIC_API_KEY ||= "mock";
  process.env.FIGMA_TOKEN ||= "mock";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://api.figma.com/")) return figmaMock(url);
    if (url.startsWith("https://api.anthropic.com/")) return claudeMock(init.body);
    return realFetch(input, init);
  };
}

const routes = {
  "/api/config": (await import("../netlify/functions/config.mjs")).default,
  "/api/gather": (await import("../netlify/functions/gather.mjs")).default,
  "/api/analyze": (await import("../netlify/edge-functions/analyze.js")).default,
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    try {
      const handler = routes[url.pathname];
      if (handler) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const request = new Request(url, {
          method: req.method,
          headers: req.headers,
          body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
        });
        const out = await handler(request, {});
        res.writeHead(out.status, Object.fromEntries(out.headers));
        if (out.body) for await (const chunk of out.body) res.write(chunk);
        return res.end();
      }
      const file = path.join(root, "public", path.normalize(url.pathname === "/" ? "/index.html" : url.pathname));
      if (!file.startsWith(path.join(root, "public"))) throw new Error("bad path");
      const data = await readFile(file);
      res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    } catch (e) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    }
  })
  .listen(PORT, () => console.log(`Scalar UI Tester on http://localhost:${PORT}${process.env.MOCK ? " (mock mode)" : ""}`));
