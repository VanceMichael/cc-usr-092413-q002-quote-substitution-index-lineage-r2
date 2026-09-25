import http from "node:http";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {Store} from "./store.js";
import {PriceEngine, EngineError, DEFAULT_POLICY} from "./engine.js";

export async function createApp({store = new Store(null), clock = () => Date.now(), policy = DEFAULT_POLICY, tickIntervalMs = 5000} = {}) {
  await store.load();
  const engine = new PriceEngine(store, policy, clock);

  async function readJson(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  function send(response, status, body) {
    response.writeHead(status, {"content-type": "application/json; charset=utf-8"});
    response.end(JSON.stringify(body));
  }

  function requireBody(body, fields) {
    for (const f of fields) {
      if (body[f] === undefined || body[f] === null) throw new EngineError("invalid_request", `缺少字段: ${f}`);
    }
  }

  const routes = [];
  const route = (method, pattern, handler) => routes.push({method, pattern, handler});

  route("GET", /^\/health$/, async () => ({status: "ok"}));

  route("POST", /^\/v1\/events$/, async (_, body) => engine.ingest(body));
  route("GET", /^\/v1\/events\/([^/]+)$/, async (m) => {
    const ev = store.snapshot().events[m[1]];
    if (!ev) throw new EngineError("not_found", "事件不存在");
    const {payload, hash, ...view} = ev;
    return {...view, payload, hash};
  });

  route("POST", /^\/v1\/points$/, async (_, body) => engine.upsertPoint(body));
  route("GET", /^\/v1\/points\/([^/]+)$/, async (m) => {
    const p = store.snapshot().points[m[1]];
    if (!p) throw new EngineError("not_found", "采价点不存在");
    return p;
  });

  route("POST", /^\/v1\/policies$/, async (_, body) => {
    requireBody(body, ["version"]);
    return engine.registerPolicy(body, body.effective_from_ms ?? clock());
  });

  route("GET", /^\/v1\/quarantine$/, async () => Object.values(store.snapshot().quarantine));
  route("POST", /^\/v1\/quarantine\/([^/]+)\/resolve$/, async (m, body) =>
    engine.resolveQuarantine(m[1], body.action ?? "accept", {
      by: body.by,
      correctedEvent: body.corrected_event ?? null,
    }));

  route("POST", /^\/v1\/substitutions\/evaluate$/, async (_, body) => {
    requireBody(body, ["point_id"]);
    return engine.evaluateSubstitution(body.point_id, body.at_ms ?? clock());
  });
  route("GET", /^\/v1\/evaluations\/([^/]+)$/, async (m) => {
    const e = store.snapshot().evaluations[m[1]];
    if (!e) throw new EngineError("not_found", "评估不存在");
    return e;
  });
  route("POST", /^\/v1\/evaluations\/([^/]+)\/approve$/, async (m, body) =>
    engine.approveSubstitution(m[1], {
      by: body.by,
      basis: body.basis,
      validFromMs: body.valid_from_ms ?? null,
      validToMs: body.valid_to_ms ?? null,
      candidatePointId: body.candidate_point_id ?? null,
    }));
  route("GET", /^\/v1\/substitutions$/, async () => Object.values(store.snapshot().substitutions));

  route("POST", /^\/v1\/index\/recompute$/, async (_, body) => {
    const key = body.key ?? (body.product_id && body.region && body.observation_day
      ? engine.periodKey(body.product_id, body.region, body.observation_day) : null);
    if (!key) throw new EngineError("invalid_request", "需要 key 或 product_id+region+observation_day");
    return engine.recomputePeriod(key);
  });
  route("POST", /^\/v1\/index\/publish$/, async (_, body) => {
    requireBody(body, ["key"]);
    return engine.publishIndex(body.key, {by: body.by});
  });
  route("GET", /^\/v1\/index\/([^/]+)$/, async (m) => {
    const p = store.snapshot().indexPeriods[decodeURIComponent(m[1])];
    if (!p) throw new EngineError("not_found", "期间不存在");
    return p;
  });

  route("POST", /^\/v1\/corrections$/, async (_, body) =>
    engine.createCorrection({
      policy_version: body.policy_version,
      product_id: body.product_id,
      region: body.region,
      from_day: body.from_day,
      to_day: body.to_day,
      reason: body.reason,
      by: body.by,
    }));
  route("POST", /^\/v1\/corrections\/([^/]+)\/approve$/, async (m, body) =>
    engine.approveCorrection(m[1], {by: body.by, basis: body.basis}));
  route("GET", /^\/v1\/corrections\/([^/]+)$/, async (m) => {
    const c = store.snapshot().corrections[m[1]];
    if (!c) throw new EngineError("not_found", "更正单不存在");
    return c;
  });

  route("GET", /^\/v1\/tasks$/, async () => Object.values(store.snapshot().tasks));
  route("POST", /^\/v1\/tasks\/tick$/, async (_, body) => engine.tick(body.at_ms ?? clock()));

  route("GET", /^\/v1\/trace$/, async (_m, _b, url) => {
    const q = url.searchParams;
    const atMs = q.has("at_ms") ? Number(q.get("at_ms")) : clock();
    if (!Number.isFinite(atMs)) throw new EngineError("invalid_request", "at_ms 非法");
    return engine.trace({
      pointId: q.get("point_id"),
      productId: q.get("product_id"),
      region: q.get("region"),
      atMs,
    });
  });

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      let body = {};
      if (request.method === "POST") {
        try {
          body = await readJson(request);
        } catch {
          return send(response, 400, {error: "invalid_json"});
        }
      }
      for (const r of routes) {
        if (r.method !== request.method) continue;
        const match = url.pathname.match(r.pattern);
        if (!match) continue;
        const result = await r.handler(match, body, url, request);
        return send(response, 200, result ?? {ok: true});
      }
      return send(response, 404, {error: "not_found"});
    } catch (err) {
      if (err instanceof EngineError) {
        const status = {
          invalid_event: 400, invalid_request: 400, invalid_policy: 400, invalid_point: 400,
          invalid_action: 400, invalid_approval: 400, invalid_correction: 400, invalid_interval: 400,
          no_candidate: 422, cycle_detected: 409, chain_too_long: 409, already_published: 409,
          not_computed: 409, gap_not_publishable: 409, invalid_state: 409, concurrent_change: 409,
          still_conflicted: 409, not_found: 404,
        }[err.code] ?? 500;
        return send(response, status, {error: err.code, message: err.message});
      }
      return send(response, 500, {error: "internal_error", message: err.message});
    }
  });

  // 重启恢复：启动时先跑一次到期任务，之后按固定间隔继续。
  await engine.tick(clock());
  const timer = tickIntervalMs
    ? setInterval(() => { engine.tick(clock()).catch(() => {}); }, tickIntervalMs)
    : null;
  if (timer) timer.unref();

  return {server, engine, store, close: () => timer && clearInterval(timer)};
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const dataFile = process.env.DATA_FILE ?? "/data/state.json";
  const {server} = await createApp({store: new Store(dataFile)});
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  server.listen(port, "0.0.0.0");
}
