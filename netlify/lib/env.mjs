// Environment and access helpers shared by the serverless functions.

export function env(name) {
  try {
    if (typeof Netlify !== "undefined" && Netlify.env) {
      const v = Netlify.env.get(name);
      if (v) return v;
    }
  } catch {}
  if (typeof process !== "undefined" && process.env) return process.env[name] || "";
  return "";
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Returns null when access is allowed, or a Response to send back. */
export function checkAccess(req) {
  const expected = env("APP_PASSCODE");
  if (!expected) return null;
  const given = req.headers.get("x-app-passcode") || "";
  let diff = expected.length ^ given.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (given.charCodeAt(i) || 0);
  if (diff === 0) return null;
  return json({ error: "The access code is missing or wrong.", code: "passcode" }, 401);
}
