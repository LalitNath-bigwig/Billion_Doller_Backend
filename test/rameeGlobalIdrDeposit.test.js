const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createIdrController, readConfig } = require("../controllers/payments/rameeGlobalIdr.controller");
const { RaamiClient } = require("../utils/raamiClient");
const { createLkrClient } = require("../utils/rameeGlobalLkrClient");
const { createCipher } = require("../utils/rameeGlobalProtocol");
const { DEDICATED_DEPOSIT_PROVIDERS, IDR_DEPOSIT_PROVIDER } = require("../services/depositCredit.service");

const accessKey = "0123456789abcdef0123456789abcdef";
const agentCode = "AGENTCODE1234567";
const env = {
  RAMEE_GLOBAL_IDR_ENABLED: "true",
  RAMEE_GLOBAL_IDR_AGENT_CODE: agentCode,
  RAMEE_GLOBAL_IDR_ACCESS_KEY: accessKey,
  RAMEE_GLOBAL_IDR_PER_USD: "16250",
};
const cipher = createCipher(accessKey);

// Fake Express response: records status and JSON body.
function response() {
  const res = { statusCode: 200, body: undefined };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  return res;
}

// In-memory orders, accounts and credit, plus a fake SDK client.
function harness({ envOverrides = {}, client: clientOverrides = {} } = {}) {
  const db = new Map();
  const sdkCalls = [];
  const credits = [];
  const orders = {
    async create([doc]) { db.set(doc.orderid, { ...doc, save: async function () { return this; } }); },
    async updateOne(filter, update) {
      const order = db.get(filter.orderid);
      if (!order || order.provider !== filter.provider) return { matchedCount: 0 };
      Object.assign(order, update.$set);
      return { matchedCount: 1 };
    },
    async findOne({ orderid, provider }) {
      const order = db.get(orderid);
      return order && order.provider === provider ? order : null;
    },
  };
  const accounts = {
    findOne: ({ accountNo }) => ({ select: async () => (accountNo === 5001 ? { _id: "acc1", accountNo: 5001 } : null) }),
  };
  const client = {
    async createOrder(params) {
      sdkCalls.push(params);
      return { success: true, httpStatus: 200, data: { url: "https://pay.example/tx/1", orderid: "G" + params.orderid.slice(3, 20), merchantid: params.orderid } };
    },
    async getOrderStatus() { throw new Error("not used"); },
    decrypt: data => cipher.decrypt(data),
    ...clientOverrides,
  };
  const controller = createIdrController({
    orders, accounts, env: { ...env, ...envOverrides },
    credit: { runDeposit: async (orderid, work) => work(db.get(orderid)), balanceWithClaim: async o => { credits.push(o); } },
    makeClient: () => client,
  });
  return { controller, db, sdkCalls, credits };
}

async function deposit(h, amount = 50000) {
  const res = response();
  await h.controller.createDeposit({ body: { accountNo: 5001, amount } }, res);
  return res;
}

async function callback(h, event, overrides = {}) {
  const res = response();
  let nextCalled = false;
  await h.controller.depositCallback({ body: { agentCode, data: cipher.encrypt(event), ...overrides } }, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

const payIn = (h, orderid, extra = {}) => ({
  service: "PayIn", merchantid: orderid, orderid: h.db.get(orderid).providerOrderId,
  currency: "IDR", amount: "50000.00", status: "SUCCESS", ...extra,
});

test("an IDR deposit converts rupiah to USD and sends whole rupiah to the gateway", async () => {
  const h = harness();
  const res = await deposit(h);
  // 50,000 IDR at 16,250 IDR/USD = US$3.07 (floored to the cent)
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.amountUSD, 3.07);
  assert.equal(res.body.url, "https://pay.example/tx/1");
  assert.match(res.body.orderid, /^IDR[0-9a-f]{20}$/);
  assert.deepEqual(h.sdkCalls[0], { currency: "IDR", amount: 50000, orderid: res.body.orderid });
  const order = h.db.get(res.body.orderid);
  assert.equal(order.provider, IDR_DEPOSIT_PROVIDER);
  assert.equal(order.providerOrderId, "G" + res.body.orderid.slice(3, 20));
  assert.deepEqual(order.rameeGlobalIdr, { amountIdr: 50000, idrMinorPerUsd: 1625000 });
});

test("IDR deposits below US$1, above the maximum or not whole rupiah are rejected before any order exists", async () => {
  const h = harness();
  for (const amount of [10000, 100001, 1000.5, "abc"]) assert.equal((await deposit(h, amount)).statusCode, 400);
  assert.equal(h.db.size, 0);
  assert.equal(h.sdkCalls.length, 0);
});

test("a gateway rejection (HTTP 200 success:false) or a mismatched reply is reported as 502", async () => {
  const rejected = harness({ client: { createOrder: async () => ({ success: false, httpStatus: 200, message: "Invalid json data." }) } });
  assert.equal((await deposit(rejected)).statusCode, 502);
  const wrong = harness({ client: { createOrder: async () => ({ success: true, httpStatus: 200, data: { url: "https://x", orderid: "Gabc1", merchantid: "OTHER123" } }) } });
  assert.equal((await deposit(wrong)).statusCode, 502);
});

test("a matching SUCCESS callback credits the USD amount once and a repeat does not double credit", async () => {
  const h = harness();
  const { orderid } = (await deposit(h)).body;
  const first = await callback(h, payIn(h, orderid));
  assert.deepEqual(first.res.body, { success: true });
  assert.equal(h.credits.length, 1);
  assert.equal(h.credits[0].balance, "3.07");
  assert.equal(h.credits[0].login, "5001");
  assert.equal(h.db.get(orderid).status, "SUCCESS");
  const repeat = await callback(h, payIn(h, orderid));
  assert.equal(repeat.res.statusCode, 503);
  assert.equal(h.credits.length, 1);
});

test("callbacks with the wrong amount or provider reference never credit", async () => {
  const h = harness();
  const { orderid } = (await deposit(h)).body;
  assert.equal((await callback(h, payIn(h, orderid, { amount: "5000000.00" }))).res.statusCode, 503);
  assert.equal((await callback(h, payIn(h, orderid, { orderid: "Gsomethingelse1" }))).res.statusCode, 503);
  assert.equal(h.credits.length, 0);
});

test("a FAILED callback marks the order failed without crediting", async () => {
  const h = harness();
  const { orderid } = (await deposit(h)).body;
  assert.deepEqual((await callback(h, payIn(h, orderid, { status: "FAILED" }))).res.body, { success: true });
  assert.equal(h.db.get(orderid).status, "FAILED");
  assert.equal(h.credits.length, 0);
});

test("non-IDR, payout, foreign-agent or undecryptable callbacks are passed on to the LKR handler", async () => {
  const h = harness();
  const { orderid } = (await deposit(h)).body;
  assert.equal((await callback(h, payIn(h, orderid, { currency: "LKR" }))).nextCalled, true);
  assert.equal((await callback(h, payIn(h, orderid, { service: "PayOut" }))).nextCalled, true);
  assert.equal((await callback(h, payIn(h, orderid), { agentCode: "OTHERAGENT123456" })).nextCalled, true);
  assert.equal((await callback(h, {}, { data: createCipher("k".repeat(32)).encrypt({}) })).nextCalled, true);
  assert.equal(h.credits.length, 0);
  // The LKR client can still read the same envelope.
  const lkr = createLkrClient({ baseUrl: "https://gateway.example/v1", agentCode, accessKey });
  assert.equal(lkr.decodeDepositCallback({ agentCode, data: cipher.encrypt({ ...payIn(h, orderid), currency: "LKR" }) }).currency, "LKR");
});

test("refresh applies the documented status reply, which has no success field", async () => {
  let statusReply;
  const h = harness({ client: { getOrderStatus: async () => statusReply } });
  const { orderid } = (await deposit(h)).body;
  statusReply = { success: true, httpStatus: 200, data: { orderid: h.db.get(orderid).providerOrderId, merchantid: orderid, amount: "50000.00", status: "PENDING" } };
  const res = response();
  await h.controller.refreshDeposit({ params: { orderid } }, res);
  assert.deepEqual(res.body, { success: true, status: "PENDING" });
});

test("RaamiClient sends X-Agent-Code as a header and only `data` in the body, as the docs require", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ path: req.url, header: req.headers["x-agent-code"], keys: Object.keys(body), payload: cipher.decrypt(body.data) });
      res.end(JSON.stringify({ orderid: "Gabc12345", merchantid: "IDRabc12345", amount: "500.00", status: "SUCCESS" }));
    });
  });
  await new Promise(resolve => server.listen(0, resolve));
  try {
    const client = new RaamiClient("production", agentCode, accessKey);
    client.baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const result = await client.getOrderStatus("IDRabc12345");
    assert.deepEqual(seen[0], { path: "/v1/order/status", header: agentCode, keys: ["data"], payload: { orderid: "IDRabc12345" } });
    assert.equal(result.success, true);
    assert.equal(result.data.status, "SUCCESS");
  } finally {
    server.close();
  }
});

test("IDR stays off unless explicitly enabled and never borrows the LKR credentials", () => {
  assert.equal(readConfig({}), null);
  assert.equal(readConfig({ ...env, RAMEE_GLOBAL_IDR_ENABLED: "True" }), null);
  assert.equal(readConfig(env).maxAmountIdr, 100000);
  assert.throws(() => readConfig({ RAMEE_GLOBAL_IDR_ENABLED: "true", RAMEE_GLOBAL_LKR_AGENT_CODE: agentCode, RAMEE_GLOBAL_LKR_ACCESS_KEY: accessKey }), /RAMEE_GLOBAL_IDR_AGENT_CODE/);
  assert.throws(() => readConfig({ ...env, RAMEE_GLOBAL_IDR_ACCESS_KEY: "short" }), /32-character/);
  assert.throws(() => readConfig({ ...env, RAMEE_GLOBAL_IDR_MAX_AMOUNT: "abc" }));
  assert.ok(DEDICATED_DEPOSIT_PROVIDERS.includes("RAMEE_GLOBAL_IDR"));
});
