import http from "node:http";
import {FileStore} from "./file-store.js";
import {LedgerService, IngestError} from "./ledger.js";
import {IndexService, periodKey} from "./index.js";
import {observationDateOf} from "./quote-event.js";

export function buildApp(context) {
  const {store, ledger, index} = context;

  const json = (response, status, body) => {
    response.writeHead(status, {"content-type": "application/json"});
    response.end(JSON.stringify(body));
  };

  const readBody = (request) => new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_048_576) reject(new Error("payload_too_large"));
    });
    request.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    request.on("error", reject);
  });

  const todayInTz = () => observationDateOf({observed_at: new Date().toISOString()}, ledger.timezone);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;
    try {
      if (request.method === "GET" && path === "/health") {
        return json(response, 200, {status: "ok", log_version: store.state.log_version});
      }

      // ---- 采价事件 ----
      if (request.method === "POST" && path === "/v1/events") {
        const body = await readBody(request);
        return json(response, 200, ledger.ingest(body));
      }
      if (request.method === "GET" && path === "/v1/events") {
        return json(response, 200, {
          events: ledger.store.listEvents(), watermark: store.state.event_watermark,
        });
      }
      if (request.method === "GET" && path === "/v1/quarantine") {
        return json(response, 200, {entries: ledger.listQuarantine(url.searchParams.get("status"))});
      }
      {
        const match = path.match(/^\/v1\/quarantine\/([^/]+)\/resolve$/);
        if (request.method === "POST" && match) {
          const body = await readBody(request);
          const entry = ledger.resolveQuarantine(
            decodeURIComponent(match[1]), body.decision, body.approval_ref,
          );
          return json(response, 200, entry);
        }
      }

      // ---- 主数据与规则 ----
      if (request.method === "POST" && path === "/v1/points") {
        return json(response, 200, ledger.registerPoint(await readBody(request)));
      }
      if (request.method === "POST" && path === "/v1/candidates") {
        return json(response, 200, ledger.registerCandidate(await readBody(request)));
      }
      if (request.method === "GET" && path === "/v1/candidates") {
        return json(response, 200, {candidates: store.state.candidates});
      }
      if (request.method === "POST" && path === "/v1/policies") {
        return json(response, 200, ledger.registerPolicy(await readBody(request)));
      }
      if (request.method === "GET" && path === "/v1/policies") {
        return json(response, 200, {policies: store.state.policies});
      }
      if (request.method === "GET" && path === "/v1/substitutions") {
        const pointId = url.searchParams.get("point_id");
        const list = pointId
          ? store.state.substitutions.filter((s) => s.failed_point_id === pointId)
          : store.state.substitutions;
        return json(response, 200, {substitutions: list});
      }
      if (request.method === "POST" && path === "/v1/admin/process-due") {
        const body = await readBody(request).catch(() => ({}));
        const date = body.date || todayInTz();
        ledger.processDueSubstitutions(date);
        return json(response, 200, {processed_at: date});
      }

      // ---- 指数期间 ----
      if (request.method === "POST" && path === "/v1/periods") {
        const body = await readBody(request);
        return json(response, 200, index.openPeriod(body.product_sku, body.region, body.period));
      }
      if (request.method === "GET" && path === "/v1/periods") {
        return json(response, 200, {periods: index.listPeriods()});
      }
      {
        const match = path.match(/^\/v1\/periods\/([^/]+)\/([^/]+)\/(\d{4}-\d{2})\/(publish|recompute)$/);
        if (request.method === "POST" && match) {
          const [, productSku, region, period, action] = match;
          const key = periodKey(decodeURIComponent(productSku), decodeURIComponent(region), period);
          if (action === "publish") {
            const body = await readBody(request);
            return json(response, 200, index.publishPeriod(key, body.approval_ref, body.as_of ?? null));
          }
          const body = await readBody(request).catch(() => ({}));
          return json(response, 200, index.runRecompute(key, body.reason ?? "manual"));
        }
      }
      if (request.method === "POST" && path === "/v1/corrections") {
        return json(response, 200, index.registerCorrection(await readBody(request)));
      }
      if (request.method === "GET" && path === "/v1/corrections") {
        return json(response, 200, {corrections: index.listCorrections()});
      }
      if (request.method === "GET" && path === "/v1/recompute-tasks") {
        return json(response, 200, {tasks: index.listRecomputeTasks()});
      }
      {
        const match = path.match(/^\/v1\/recompute-tasks\/([^/]+)\/commit$/);
        if (request.method === "POST" && match) {
          return json(response, 200, index.commitRecompute(decodeURIComponent(match[1])));
        }
      }
      if (request.method === "GET" && path === "/v1/index") {
        const productSku = url.searchParams.get("product_sku");
        const region = url.searchParams.get("region");
        const date = url.searchParams.get("date") ?? todayInTz();
        if (!productSku || !region) return json(response, 400, {error: "product_sku 与 region 必填"});
        return json(response, 200, index.computeIndex(productSku, region, date));
      }

      // ---- 任一观察时刻还原 ----
      if (request.method === "GET" && path === "/v1/trace") {
        const pointId = url.searchParams.get("point_id");
        const date = url.searchParams.get("date") ?? todayInTz();
        if (!pointId) return json(response, 400, {error: "point_id 必填"});
        return json(response, 200, index.trace(pointId, date));
      }

      return json(response, 404, {error: "not_found"});
    } catch (error) {
      return mapError(response, error);
    }
  });

  return {server, todayInTz};
}

function mapError(response, error) {
  const statusByCode = {
    invalid_event: 400, invalid_json: 400, invalid_point: 400, invalid_candidate: 400,
    invalid_policy: 400, invalid_decision: 400, approval_required: 400,
    not_found: 404, policy_version_exists: 409, period_not_open: 409,
    period_not_found: 404, stale_recompute_result: 409,
    period_no_longer_open: 409, task_not_found: 404, task_not_pending: 409,
    policy_version_not_found: 404,
  };
  const code = error.code || error.message;
  const status = statusByCode[code] ?? (error instanceof IngestError ? 400 : 500);
  response.writeHead(status, {"content-type": "application/json"});
  response.end(JSON.stringify({
    error: code, message: error.message,
    ...(error.code === "stale_recompute_result" ? {task_id: error.task_id} : {}),
  }));
}

export function createContext(dataDir = process.env.DATA_DIR || "/data") {
  const store = new FileStore(dataDir);
  const ledger = new LedgerService(store);
  const index = new IndexService(store, ledger);
  return {store, ledger, index};
}

const invokedDirectly = process.argv[1] && import.meta.filename === process.argv[1];
if (invokedDirectly) {
  const context = createContext();
  const {server, todayInTz} = buildApp(context);
  // 启动恢复：隔离条目继续暴露、到期替代重放、未完成重算重取数后提交。
  const ledgerResume = context.ledger.resumeOnStartup(todayInTz());
  const recomputeResume = context.index.resumeRecompute();
  // 每小时补一次到期处理（timer 不阻止退出）。
  const timer = setInterval(() => context.ledger.processDueSubstitutions(todayInTz()), 60 * 60 * 1000);
  timer.unref();

  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  server.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({
      msg: "consumer-quote-ledger started", port, today: todayInTz(),
      resume: {...ledgerResume, recompute: recomputeResume},
    }));
  });
}
