// Live-URL evidence gathering: fetch the page's HTML and stylesheets on the
// server and trim them down to what a reviewer needs. No browser runs here,
// so pages that render in the browser (single-page apps) come back nearly empty.

import dns from "node:dns/promises";
import net from "node:net";

const MAX_HTML_BYTES = 600_000;
const MAX_HTML_CHARS = 60_000;
const MAX_CSS_CHARS = 36_000;
const MAX_STYLESHEETS = 4;
const TIMEOUT_MS = 8000;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  return true;
}

export function blockedHostname(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (net.isIP(h)) return isPrivateIp(h);
  if (/^[0-9.]+$/.test(h) || /^0x/i.test(h)) return true; // numeric tricks
  return false;
}

async function assertPublic(url, lookup) {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https links can be tested.");
  if (blockedHostname(url.hostname)) {
    throw new Error("This address is private or local, so the hosted app cannot reach it. Upload screenshots instead.");
  }
  if (!net.isIP(url.hostname)) {
    let addrs;
    try {
      addrs = await lookup(url.hostname, { all: true });
    } catch {
      throw new Error(`The address ${url.hostname} could not be found.`);
    }
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
      throw new Error("This address resolves to a private network, so the hosted app cannot reach it. Upload screenshots instead.");
    }
  }
}

async function safeFetch(rawUrl, opts) {
  const fetchImpl = opts.fetchImpl || fetch;
  const lookup = opts.lookup || dns.lookup;
  let url = new URL(rawUrl);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url, lookup);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(url.href, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "User-Agent": "ScalarUITester/1.0 (+ui review)", Accept: opts.accept || "text/html,*/*" },
      });
    } catch (e) {
      throw new Error(
        e.name === "AbortError" ? `${url.hostname} took too long to respond.` : `${url.hostname} could not be reached.`
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), url);
      continue;
    }
    return { res, finalUrl: url };
  }
  throw new Error("The link redirects too many times.");
}

async function readCapped(res, maxBytes) {
  const buf = await res.arrayBuffer();
  const slice = buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf;
  return new TextDecoder("utf-8").decode(slice);
}

export function trimHtml(html) {
  const inlineStyles = [];
  let out = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (m, css) => {
      inlineStyles.push(css);
      return "";
    })
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg\b([^>]*)>[\s\S]*?<\/svg>/gi, "<svg$1></svg>")
    .replace(/\s(src|href|srcset|poster)=("|')data:[^"']*\2/gi, ' $1="data:…"')
    .replace(/\s(d|points)=("|')[^"']{80,}\2/gi, "")
    .replace(/\sclass=("|')([^"']{160,})\1/gi, (m, q, v) => ` class=${q}${v.slice(0, 160)}…${q}`)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  let truncated = false;
  if (out.length > MAX_HTML_CHARS) {
    out = out.slice(0, MAX_HTML_CHARS);
    truncated = true;
  }
  return { html: out, inlineCss: inlineStyles.join("\n"), truncated };
}

export function trimCss(css, max = MAX_CSS_CHARS) {
  let out = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/url\(\s*("|')?data:[^)]*\)/gi, "url(data:…)")
    .replace(/\s+/g, " ")
    .trim();
  let truncated = false;
  if (out.length > max) {
    out = out.slice(0, max);
    truncated = true;
  }
  return { css: out, truncated };
}

export function visibleTextLength(html) {
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  const src = (body ? body[1] : html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return src.length;
}

function stylesheetLinks(html, base) {
  const out = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (!/rel=("|')?[^"'>]*stylesheet/i.test(tag)) continue;
    const href = tag.match(/href=("|')([^"']+)\1/i);
    if (!href) continue;
    try {
      out.push(new URL(href[2], base).href);
    } catch {}
  }
  return [...new Set(out)].slice(0, MAX_STYLESHEETS);
}

/** Collect evidence for a public web page. opts: { fetchImpl, lookup } (both optional, for tests). */
export async function gatherWeb(rawUrl, opts = {}) {
  const warnings = [];
  const notes = [];
  const { res, finalUrl } = await safeFetch(rawUrl, opts);

  if (res.status === 401 || res.status === 403) {
    throw new Error("This page needs a sign-in, so the hosted app cannot open it. Upload screenshots of the screens instead.");
  }
  if (!res.ok) throw new Error(`The page returned an error (${res.status}).`);
  const type = res.headers.get("content-type") || "";
  if (type && !/html|xml/i.test(type)) throw new Error("This link does not point at a web page.");

  const raw = await readCapped(res, MAX_HTML_BYTES);
  const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
  const textLen = visibleTextLength(raw);
  const { html, inlineCss, truncated } = trimHtml(raw);

  if (textLen < 200) {
    warnings.push(
      "This page builds its content in the browser, so the server only received an empty shell. Add screenshots of the screens for a real review."
    );
  }
  if (/type=("|')password\1/i.test(raw) && textLen < 1500) {
    warnings.push("This looks like a sign-in page. If the prototype sits behind it, upload screenshots of the screens you want tested.");
  }
  if (truncated) warnings.push("The page markup is long; only the first part was reviewed.");

  const cssParts = [];
  if (inlineCss.trim()) cssParts.push("/* inline <style> blocks */\n" + inlineCss);
  const links = stylesheetLinks(raw, finalUrl);
  const sheets = await Promise.all(
    links.map(async (href) => {
      try {
        const r = await safeFetch(href, { ...opts, accept: "text/css,*/*" });
        if (!r.res.ok) return null;
        return `/* ${new URL(href).pathname.split("/").pop() || "stylesheet"} */\n` + (await readCapped(r.res, 400_000));
      } catch {
        return null;
      }
    })
  );
  for (const s of sheets) if (s) cssParts.push(s);
  const css = trimCss(cssParts.join("\n"));
  if (css.truncated) notes.push("Stylesheets were long; only the first part was included.");

  notes.push(
    "Live pages are read as markup and styles, without a browser. Layout, rendered colours and behaviour are only visible in screenshots you add."
  );

  return {
    kind: "web",
    title: title || finalUrl.hostname,
    method: "Live page (server-fetched HTML and CSS, no browser)",
    finalUrl: finalUrl.href,
    html,
    css: css.css,
    screens: [],
    notes,
    warnings,
  };
}
