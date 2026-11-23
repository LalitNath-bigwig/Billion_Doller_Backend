const test = require("node:test");
const assert = require("node:assert/strict");
const { createIdrDepositService, idrClient } = require("../services/rameeGlobalIdrDeposit.service");
const { createLkrClient } = require("../utils/rameeGlobalLkrClient");
const idr = require("../utils/rameeGlobalIdrClient");
const { createCipher } = require("../utils/rameeGlobalProtocol");
const { DEDICATED_DEPOSIT_PROVIDERS, IDR_DEPOSIT_PROVIDER } = require("../services/depositCredit.service");

const accessKey = "0123456789abcdef0123456789abcdef";
const agentCode = "AGENTCODE1234567";
const account = { _id: "acc1", accountNo: 5001 };

function harness({ maxAmountIdr } = {}) {
  const db = new Map();
  const checkouts = [];
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
  const client = {
    async createCheckout(order) {
      checkouts.push(order);
      return { providerOrderId: "G" + order.orderid.slice(3, 20), url: "https://pay.example/tx/1" };
    },
    async depositStatus() { throw new Error("not used"); },
  };
  const runDeposit = async (orderid, work) => work(db.get(orderid));
  const balanceWithClaim = async options => { credits.push(options); return { retcode: "0 Done" }; };
  const service = createIdrDepositService({ client, orders, runDeposit, balanceWithClaim, maxAmountIdr });
  return { service, db, checkouts, credits };
}

test("an IDR deposit converts rupiah to USD and sends whole rupiah to the gateway", async () => {
  const { service, db, checkouts } = harness();
  // 50,000 IDR at 16,250.00 IDR/USD = US$3.07 (floored to the cent)
  const result = await service.createDeposit({ account, amountIdr: 50000, idrMinorPerUsd: 1625000 });
  assert.equal(result.amountUSD, 3.07);
  assert.equal(result.amountIdr, 50000);
  assert.equal(result.url, "https://pay.example/tx/1");
  assert.match(result.orderid, /^IDR[0-9a-f]{32}$/);
  assert.equal(checkouts[0].amountIdr, 50000);
  const order = db.get(result.orderid);
  assert.equal(order.provider, IDR_DEPOSIT_PROVIDER);
  assert.deepEqual(order.rameeGlobalIdr, { amountIdr: 50000, idrMinorPerUsd: 1625000 });
});

test("IDR deposits below US$1 or above the configured maximum are rejected before any order exists", async () => {
  const { service, db, checkouts } = harness({ maxAmountIdr: 100000 });
  await assert.rejects(service.createDeposit({ account, amountIdr: 10000, idrMinorPerUsd: 1625000 }), RangeError);
  await assert.rejects(service.createDeposit({ account, amountIdr: 100001, idrMinorPerUsd: 1625000 }), RangeError);
  await assert.rejects(service.createDeposit({ account, amountIdr: 1000.5, idrMinorPerUsd: 1625000 }), RangeError);
  assert.equal(db.size, 0);
  assert.equal(checkouts.length, 0);
});

test("a matching SUCCESS callback credits the USD amount once and a repeat does not double credit", async () => {
  const { service, db, credits } = harness();
  const { orderid } = await service.createDeposit({ account, amountIdr: 50000, idrMinorPerUsd: 1625000 });
  const event = { service: "PayIn", merchantid: orderid, orderid: db.get(orderid).providerOrderId, currency: "IDR", amount: "50000.00", status: "SUCCESS" };
  assert.equal(await service.applyCallback(event), "SUCCESS");
  assert.equal(credits.length, 1);
  assert.equal(credits[0].balance, "3.07");
  assert.equal(credits[0].login, "5001");
  assert.equal(db.get(orderid).status, "SUCCESS");
  await assert.rejects(service.applyCallback(event), /requires reconciliation/);
  assert.equal(credits.length, 1);
});

test("callbacks with the wrong amount, currency or provider reference never credit", async () => {
  const { service, db, credits } = harness();
  const { orderid } = await service.createDeposit({ account, amountIdr: 50000, idrMinorPerUsd: 1625000 });
  const good = { service: "PayIn", merchantid: orderid, orderid: db.get(orderid).providerOrderId, currency: "IDR", amount: "50000.00", status: "SUCCESS" };
  await assert.rejects(service.applyCallback({ ...good, amount: "5000000.00" }), /does not match/);
  await assert.rejects(service.applyCallback({ ...good, currency: "LKR" }), /does not match/);
  await assert.rejects(service.applyCallback({ ...good, orderid: "Gsomethingelse1" }), /does not match/);
  assert.equal(credits.length, 0);
});

test("a FAILED callback marks the order failed without crediting", async () => {
  const { service, db, credits } = harness();
  const { orderid } = await service.createDeposit({ account, amountIdr: 50000, idrMinorPerUsd: 1625000 });
  const event = { merchantid: orderid, orderid: db.get(orderid).providerOrderId, currency: "IDR", amount: "50000.00", status: "FAILED" };
  assert.equal(await service.applyCallback(event), "FAILED");
  assert.equal(db.get(orderid).status, "FAILED");
  assert.equal(credits.length, 0);
});

// The IDR client reads process.env and the global fetch, like the docs' helper.
// withIdr sets them for one test, silences the debug logs, and restores everything.
const idrEnv = { RAMEE_GLOBAL_IDR_ENABLED: "true", RAMEE_GLOBAL_IDR_API_BASE: "https://gateway.example/v1",
  RAMEE_GLOBAL_IDR_AGENT_CODE: agentCode, RAMEE_GLOBAL_IDR_ACCESS_KEY: accessKey };
async function withIdr(env, fetchImpl, fn) {
  const saved = { env: { ...process.env }, fetch: globalThis.fetch, log: console.log };
  for (const k of Object.keys(process.env)) if (k.startsWith("RAMEE_GLOBAL_IDR_")) delete process.env[k];
  Object.assign(process.env, env);
  if (fetchImpl) globalThis.fetch = fetchImpl;
  console.log = () => {};
  try { return await fn(); } finally {
    process.env = saved.env; globalThis.fetch = saved.fetch; console.log = saved.log;
  }
}

test("the IDR client only decodes IDR pay-in callbacks from its own agent", () => withIdr(idrEnv, null, () => {
  const cipher = createCipher(accessKey);
  const envelope = currency => ({ agentCode, data: cipher.encrypt({ service: "PayIn", merchantid: "IDRabc12345", orderid: "Gx1", currency, amount: "1.00", status: "SUCCESS" }) });
  assert.equal(idr.decodeDepositCallback(envelope("IDR")).currency, "IDR");
  assert.throws(() => idr.decodeDepositCallback(envelope("LKR")), /Invalid IDR deposit callback/);
  assert.throws(() => idr.decodeDepositCallback({ ...envelope("IDR"), agentCode: "OTHERAGENT123456" }), /callback agent/);
  const lkr = createLkrClient({ baseUrl: "https://gateway.example/v1", agentCode, accessKey });
  assert.equal(lkr.decodeDepositCallback(envelope("LKR")).currency, "LKR");
}));

test("IDR encryption matches the documented layout: Base64(IV 12 + tag 16 + ciphertext)", () => withIdr(idrEnv, null, () => {
  const crypto = require("node:crypto");
  const data = idr.encrypt({ a: 1 });
  const raw = Buffer.from(data, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(accessKey, "utf8"), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  assert.deepEqual(JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString()), { a: 1 });
  assert.deepEqual(idr.decrypt(data), { a: 1 });
}));

test("the gateway receives the documented IDR order", async () => {
  const sent = [];
  const cipher = createCipher(accessKey);
  const fetchImpl = async (url, init) => {
    assert.equal(url, "https://gateway.example/v1/order/generate");
    assert.equal(init.headers["X-Agent-Code"], agentCode);
    sent.push(cipher.decrypt(JSON.parse(init.body).data));
    return Response.json({ success: true, url: "https://pay.example/tx/9", orderid: "Gabc12345", merchantid: "IDRabc12345" });
  };
  await withIdr(idrEnv, fetchImpl, async () => {
    assert.deepEqual(await idr.createCheckout({ orderid: "IDRabc12345", amountIdr: 50000 }), { providerOrderId: "Gabc12345", url: "https://pay.example/tx/9" });
  });
  assert.deepEqual(sent[0], { currency: "IDR", amount: 50000, orderid: "IDRabc12345" });
});

test("IDR surfaces documented gateway errors, including HTTP 200 success:false and encrypted replies", async () => {
  const cipher = createCipher(accessKey);
  const run = reply => withIdr(idrEnv, async () => reply(), () => idr.createCheckout({ orderid: "IDRabc12345", amountIdr: 100 }));
  await assert.rejects(run(() => Response.json({ success: false, message: "This service not available for you, contact support" }, { status: 400 })),
    /^Error: RameeGlobalPay rejected the IDR request \(HTTP 400\): This service not available for you, contact support$/);
  await assert.rejects(run(() => Response.json({ success: false, message: "Unauthorized..!" })), /\(HTTP 200\): Unauthorized\.\.!/);
  await assert.rejects(run(() => Response.json({ success: true, data: cipher.encrypt({ success: false, message: "Invalid Amount." }) }, { status: 400 })),
    /\(HTTP 400\): Invalid Amount\./);
  await assert.rejects(run(() => Response.json({ success: true, data: createCipher("k".repeat(32)).encrypt({}) }, { status: 400 })), /cannot decrypt/);
});

test("IDR order status accepts the documented reply without a success field", async () => {
  const fetchImpl = async () => Response.json({ orderid: "Gabc12345", merchantid: "IDRabc12345", amount: "50000.00", status: "PENDING" });
  const status = await withIdr(idrEnv, fetchImpl, () => idr.depositStatus("IDRabc12345"));
  assert.equal(status.status, "PENDING");
});

test("IDR stays off unless explicitly enabled and never borrows the LKR credentials", async () => {
  await withIdr({}, null, () => assert.equal(idrClient(), null));
  await withIdr({ RAMEE_GLOBAL_IDR_ENABLED: "True" }, null, () => assert.equal(idrClient(), null));
  await withIdr(idrEnv, null, () => assert.equal(typeof idrClient().createCheckout, "function"));
  await withIdr({ RAMEE_GLOBAL_IDR_ENABLED: "true", RAMEE_GLOBAL_LKR_API_BASE: "https://gateway.example/v1",
    RAMEE_GLOBAL_LKR_AGENT_CODE: agentCode, RAMEE_GLOBAL_LKR_ACCESS_KEY: accessKey }, null,
  () => assert.throws(() => idrClient(), /RAMEE_GLOBAL_IDR_API_BASE/));
  await withIdr({ ...idrEnv, RAMEE_GLOBAL_IDR_ACCESS_KEY: "short" }, null, () => assert.throws(() => idrClient(), /32-character/));
  await withIdr({ ...idrEnv, RAMEE_GLOBAL_IDR_MAX_AMOUNT: "abc" }, null, () => assert.throws(() => idrClient()));
  assert.ok(DEDICATED_DEPOSIT_PROVIDERS.includes("RAMEE_GLOBAL_LKR") && DEDICATED_DEPOSIT_PROVIDERS.includes("RAMEE_GLOBAL_IDR"));
});
