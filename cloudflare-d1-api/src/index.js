/**
 * Cloudflare Worker -> D1 bridge for the Railway Telegram bot.
 *
 * The Railway app never receives the Cloudflare D1 API token.
 * It calls this Worker with D1_API_SECRET.
 *
 * Routes:
 *   GET  /health
 *   POST /query  { "sql": "...", "params": [...] }
 *   POST /batch  { "batch": [{ "sql": "...", "params": [...] }] }
 */

function authorized(request, env) {
  const expected = String(env.D1_API_SECRET || "");
  const supplied = String(request.headers.get("authorization") || "");

  if (!expected || supplied !== `Bearer ${expected}`) {
    return false;
  }

  return true;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function validParams(params) {
  return Array.isArray(params) &&
    params.length <= 100 &&
    params.every((value) =>
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "account-store-d1" });
    }

    if (!authorized(request, env)) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    try {
      const body = await request.json();

      if (url.pathname === "/query") {
        const sql = String(body?.sql || "").trim();
        const params = body?.params ?? [];

        if (!sql) return json({ error: "sql is required" }, 400);
        if (!validParams(params)) {
          return json({ error: "params must be an array of <=100 scalar values" }, 400);
        }

        const result = await env.DB
          .prepare(sql)
          .bind(...params)
          .all();

        return json(result);
      }

      if (url.pathname === "/batch") {
        const batch = body?.batch;

        if (!Array.isArray(batch) || batch.length === 0 || batch.length > 100) {
          return json({ error: "batch must contain 1-100 queries" }, 400);
        }

        const statements = [];

        for (const item of batch) {
          const sql = String(item?.sql || "").trim();
          const params = item?.params ?? [];

          if (!sql || !validParams(params)) {
            return json({ error: "Invalid batch query" }, 400);
          }

          statements.push(
            env.DB.prepare(sql).bind(...params)
          );
        }

        const result = await env.DB.batch(statements);

        return json({
          success: true,
          results: result,
        });
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error("[D1 API]", error);
      return json({
        error: String(error?.message || error),
      }, 500);
    }
  },
};
