const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { createBuddyService, reportAuthorized } = require("../services/buddyN8n.service");
const { createReportService } = require("../services/buddyReport.service");
const { createWorker } = require("../services/buddyAiWorker.service");
const { createDailyReportService } = require("../services/bdfxDailyReport.service");
const { createTelegramQueryService, TOPICS } = require("../services/bdfxTelegramQuery.service");
const { createOperationsAssistant } = require("../services/bdfxOperationsAssistant.service");
const { followUpReport } = require("../services/crm.service");
const { createAgentRegistrationNotices } = require("../services/agentRegistrationNotices.service");
function createRouter({ env = process.env, worker = createWorker({ env }), buddy = createBuddyService({ env, worker }), report = createReportService(), dailyReport = createDailyReportService(), telegramQuery = createTelegramQueryService({ dailyReport }), operationsAssistant = createOperationsAssistant({ env, query: telegramQuery }), crmReport = followUpReport, registrationNotices = createAgentRegistrationNotices({ env }) } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }); next(); });
  const limit = maximum => rateLimit({ windowMs: 900000, limit: maximum, standardHeaders: "draft-7", legacyHeaders: false,
    message: { code: "SUPPORT_RATE_LIMIT" } });
  router.get("/options", (_req, res) => res.json({ available: buddy.available(), requiresConsent: true }));
  router.post("/reply", limit(12), express.json({ limit: "6kb" }), async (req, res) => {
    const result = await buddy.reply(req.body); res.status(result.status).json(result.body);
  });
  router.post("/complete", limit(120), express.json({ limit: "8kb" }), async (req, res) => {
    const result = await worker.complete(req.body); res.status(result.status).json(result.body);
  });
  router.get("/report", limit(60), async (req, res) => {
    if (env.BDFX_N8N_REPORT_TOKEN === env.BDFX_BUDDY_N8N_TOKEN || !reportAuthorized(req.get("X-BDFX-Report-Key"), env.BDFX_N8N_REPORT_TOKEN)) return res.status(401).json({ code: "REPORT_AUTH_REQUIRED" });
    if (Object.keys(req.query).some(key => key !== "days") || (req.query.days != null && !["1", "7", "30"].includes(req.query.days))) return res.status(400).json({ code: "INVALID_REPORT_PERIOD" });
    try { res.json(await report(req.query.days || "7")); }
    catch { res.status(503).json({ code: "REPORT_UNAVAILABLE" }); }
  });
  router.get("/business-report", limit(60), async (req, res) => {
    const expected = env.BDFX_N8N_BUSINESS_REPORT_TOKEN;
    if ([env.BDFX_BUDDY_N8N_TOKEN, env.BDFX_N8N_REPORT_TOKEN].includes(expected) || !reportAuthorized(req.get("X-BDFX-Business-Report-Key"), expected)) return res.status(401).json({ code: "REPORT_AUTH_REQUIRED" });
    if (Object.keys(req.query).length) return res.status(400).json({ code: "INVALID_REPORT_PERIOD" });
    try { res.json(await dailyReport()); }
    catch { res.status(503).json({ code: "REPORT_UNAVAILABLE" }); }
  });
  router.get("/business-query", limit(120), async (req, res) => {
    const expected = env.BDFX_N8N_BUSINESS_REPORT_TOKEN;
    if ([env.BDFX_BUDDY_N8N_TOKEN, env.BDFX_N8N_REPORT_TOKEN].includes(expected) || !reportAuthorized(req.get("X-BDFX-Business-Report-Key"), expected)) return res.status(401).json({ code: "REPORT_AUTH_REQUIRED" });
    if (Object.keys(req.query).some(key => !["topic", "page"].includes(key)) || !TOPICS.includes(req.query.topic)
      || (req.query.page != null && (typeof req.query.page !== "string" || !/^[1-9]\d{0,2}$/.test(req.query.page)))
      || (req.query.topic !== "pending_withdrawals" && req.query.page != null && req.query.page !== "1")) return res.status(400).json({ code: "INVALID_BUSINESS_QUERY" });
    try { res.json(await telegramQuery(req.query.topic, Number(req.query.page || "1"))); }
    catch { res.status(503).json({ code: "REPORT_UNAVAILABLE" }); }
  });
  const operationsAuth = (req, res, next) => {
    const expected = env.BDFX_N8N_BUSINESS_REPORT_TOKEN;
    if ([env.BDFX_BUDDY_N8N_TOKEN, env.BDFX_N8N_REPORT_TOKEN].includes(expected) || !reportAuthorized(req.get("X-BDFX-Business-Report-Key"), expected)) return res.status(401).json({ code: "REPORT_AUTH_REQUIRED" });
    next();
  };
  const paymentAlerts = require("../services/paymentAlerts.service");
  router.post("/payment-alerts/poll", operationsAuth, limit(150), async (req, res) => {
    try { res.json({ items: await paymentAlerts.poll(req.body?.wait !== false) }); }
    catch { res.status(503).json({ code: "PAYMENT_ALERT_SOURCE_UNAVAILABLE" }); }
  });
  router.post("/payment-alerts/prepare", operationsAuth, limit(1200), async (req, res) => {
    try { res.json({ item: await paymentAlerts.prepare(req.body?.key) }); }
    catch { res.status(503).json({ code: "PAYMENT_ALERT_SOURCE_UNAVAILABLE" }); }
  });
  router.post("/payment-alerts/begin", operationsAuth, limit(1200), async (req, res) => {
    try { res.json({ send: await paymentAlerts.begin(req.body) }); }
    catch { res.status(503).json({ code: "PAYMENT_ALERT_SOURCE_UNAVAILABLE" }); }
  });
  for (const [path, complete] of [["receipt", paymentAlerts.receipt], ["rejected", paymentAlerts.releaseRejected]]) {
    router.post("/payment-alerts/" + path, operationsAuth, limit(1200), async (req, res) => {
      try { const status = await complete(req.body); res.status(status).json({ success: status === 200 }); }
      catch { res.status(503).json({ code: "PAYMENT_ALERT_RECEIPT_UNAVAILABLE" }); }
    });
  }
  router.get("/crm-follow-ups", limit(60), operationsAuth, async (req, res) => {
    if (Object.keys(req.query).length) return res.status(400).json({ code: "INVALID_REPORT_QUERY" });
    try { res.json(await crmReport()); }
    catch { res.status(503).json({ code: "REPORT_UNAVAILABLE" }); }
  });
  router.post("/agent-registrations/claim", limit(60), operationsAuth, async (_req, res) => {
    try {
      const items = await registrationNotices.claim();
      return items ? res.json({ items }) : res.status(503).json({ code: "AGENT_NOTICES_NOT_CONFIGURED" });
    } catch { return res.status(503).json({ code: "AGENT_NOTICES_UNAVAILABLE" }); }
  });
  router.post("/agent-registrations/receipt", limit(300), operationsAuth, express.json({ limit: "2kb" }), async (req, res) => {
    try {
      const status = await registrationNotices.receipt(req.body);
      res.status(status).json({ success: status === 200 });
    } catch { res.status(503).json({ code: "AGENT_NOTICE_RECEIPT_UNAVAILABLE" }); }
  });
  router.get("/business-assistant/options", limit(60), operationsAuth, (_req, res) => res.json(operationsAssistant.status()));
  router.post("/business-assistant", limit(60), operationsAuth, express.json({ limit: "8kb" }), async (req, res) => {
    const result = await operationsAssistant.reply(req.body); res.status(result.status).json(result.body);
  });
  return router;
}
module.exports = createRouter();
module.exports.createRouter = createRouter;
