const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createController, dubaiDateRange } = require("../controllers/operationsController");
const { createAudit } = require("../middleware/adminAudit");
const { createHealth } = require("../controllers/healthController");
const response = () => ({ code: 200, status(value) { this.code = value; return this; }, set() { return this; }, json(data) { this.data = data; return this; } });

test("business dates use complete Dubai days and reject invalid or excessive ranges", () => {
  const range = dubaiDateRange("2026-10-20");
  assert.equal(range.start.toISOString(), "2026-10-19T20:00:00.000Z");
  assert.equal(range.end.toISOString(), "2026-10-20T20:00:00.000Z");
  assert.equal(dubaiDateRange(undefined, undefined, new Date("2026-10-20T22:00:00Z")).from, "2026-10-21");
  for (const [from, to] of [["2026-02-30"], ["2026-10-21", "2026-10-19"], ["2024-01-01", "2026-01-01"], [{ $ne: null }]]) assert.throws(() => dubaiDateRange(from, to));
});

test("onboarding first-deposit status comes from successful orders scoped to owned live accounts", async () => {
  let depositQuery, accountQuery;
  const select = data => ({ select() { return this; }, lean: async () => data });
  const controller = createController({ users: { findById: () => select({ isVerified: true, isKycVerified: true, kycProvider: "veriff" }) },
    accounts: { find: query => { accountQuery = query; return select([{ _id: "own-account", accountNo: 123456 }]); } },
    orders: { exists: async query => { depositQuery = query; return null; } },
    ibs: { findOne: () => select({ status: "approved" }) } });
  const res = response();
  await controller.onboarding({ principal: { id: "own-user", email: "own@example.invalid" } }, res, error => { throw error; });
  assert.deepEqual(accountQuery, { user: "own-user", accountType: "LIVE" });
  assert.equal(depositQuery.status, "SUCCESS");
  assert.deepEqual(depositQuery.$or, [{ account: { $in: ["own-account"] } }, { accountNo: { $in: ["123456"] } }]);
  assert.equal(res.data.firstDepositCompleted, false);
  assert.equal(res.data.tradingAccountCreated, true);
  assert.equal(res.data.ibStatus, "approved");
  assert.equal(res.data.email, undefined);
  assert.equal(res.data.accounts, undefined);
});

test("audit records administrator outcomes without retaining bodies, credentials or URL parameters", async () => {
  const records = [];
  const res = new EventEmitter(); res.set = () => {}; res.statusCode = 200;
  const req = { method: "PATCH", originalUrl: "/api/auth/user/private@example.invalid?otp=123456", route: { path: "/user/:email" }, params: { email: "private@example.invalid" }, body: { password: "must-never-be-logged", otp: "123456" }, headers: { authorization: "secret-token" }, principal: { isAdmin: true, id: "admin-1", email: "owner@example.invalid" } };
  createAudit({ logs: { create: async value => records.push(value) } })(req, res, () => {});
  res.emit("finish"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(records.length, 1);
  assert.equal(records[0].route, "/user/:email");
  assert.equal(records[0].resource, "/api/auth");
  for (const secret of ["123456", "must-never-be-logged", "secret-token", "private@example.invalid"]) assert.equal(JSON.stringify(records).includes(secret), false);
  const clientRes = new EventEmitter(); clientRes.set = () => {};
  createAudit({ logs: { create: async () => assert.fail("client request recorded as admin") } })({ ...req, principal: { isAdmin: false } }, clientRes, () => {});
  clientRes.emit("finish"); await new Promise(resolve => setImmediate(resolve));
});

test("health checks report database availability without connection strings or account data", () => {
  for (const state of [0, 1]) {
    const res = response(); createHealth({ connection: { readyState: state, host: "private-db-host" } })({}, res);
    assert.equal(res.code, state ? 200 : 503);
    assert.equal(JSON.stringify(res.data).includes("private-db-host"), false);
  }
});

test("business report details enforce category permissions and use the same Dubai dates as the count", async () => {
  const filters = [];
  const users = {
    countDocuments: async filter => { filters.push(filter); return 1; },
    find(filter) {
      filters.push(filter);
      return { select() { return this; }, sort() { return this; }, skip(value) { assert.equal(value, 0); return this; }, limit(value) { assert.equal(value, 25); return this; }, lean: async () => [{ _id: "client", fullName: "Example Client", email: "client@example.invalid", password: "excluded" }] };
    },
  };
  const controller = createController({ users });
  const query = { group: "period", metric: "registrations", from: "2026-11-14", to: "2026-11-14" };
  const invocations = [
    { principal: { adminRole: "manager", permissions: ["reports"] }, query, code: 403 },
    { principal: { adminRole: "owner" }, query: { ...query, metric: "constructor" }, code: 400 },
    { principal: { adminRole: "owner" }, query, code: 200 },
    { principal: { adminRole: "manager", permissions: ["reports", "clients"] }, query: { group: "queue", metric: "pendingKyc", from: "invalid" }, code: 200 },
  ];
  for (const { principal, query, code } of invocations) {
    const res = response();
    await controller.reportDetails({ principal, query }, res, error => { throw error; });
    assert.equal(res.code, code);
    if (code !== 200) continue;
    assert.equal(res.data.data[0].clientId, "client");
    assert.equal(res.data.data[0].password, undefined);
  }
  assert.deepEqual(filters, [
    ...Array(2).fill({ isVerified: true, createdAt: { $gte: new Date("2026-11-13T20:00:00Z"), $lt: new Date("2026-11-14T20:00:00Z") } }),
    ...Array(2).fill({ isVerified: true, isKycVerified: false }),
  ]);
});

test("operational reports, activity history and onboarding status require authentication", async () => {
  const app = require("express")(); app.use("/api/operations", require("../routes/operationsRoutes"));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  try {
    for (const path of ["overview", "report", "report/details", "audit", "onboarding"]) assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/operations/${path}`)).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
