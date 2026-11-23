const test = require("node:test");
const assert = require("node:assert/strict");
const { createIdrDepositService, idrClient } = require("../services/rameeGlobalIdrDeposit.service");
const { createLkrClient } = require("../utils/rameeGlobalLkrClient");
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
  assert.equal(checkouts[0].amountLkrMinor, 5000000); // 50,000.00 -> client sends 50000
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

test("the IDR client only decodes IDR pay-in callbacks and the LKR default is unchanged", async () => {
  const cipher = createCipher(accessKey);
  const base = { baseUrl: "https://gateway.example/v1", agentCode, accessKey };
  const idr = createLkrClient({ ...base, currency: "IDR" });
  const lkr = createLkrClient(base);
  const envelope = currency => ({ agentCode, data: cipher.encrypt({ service: "PayIn", merchantid: "IDRabc12345", orderid: "Gx1", currency, amount: "1.00", status: "SUCCESS" }) });
  assert.equal(idr.decodeDepositCallback(envelope("IDR")).currency, "IDR");
  assert.throws(() => idr.decodeDepositCallback(envelope("LKR")), /Invalid IDR deposit callback/);
  assert.equal(lkr.decodeDepositCallback(envelope("LKR")).currency, "LKR");
  assert.throws(() => lkr.decodeDepositCallback(envelope("IDR")), /Invalid LKR deposit callback/);
});

test("the gateway receives the IDR currency and honours the configured maximum", async () => {
  const sent = [];
  const cipher = createCipher(accessKey);
  const fetchImpl = async (_url, init) => {
    sent.push(cipher.decrypt(JSON.parse(init.body).data));
    return Response.json({ success: true, url: "https://pay.example/tx/9", orderid: "Gabc12345", merchantid: "IDRabc12345" });
  };
  const client = createLkrClient({ baseUrl: "https://gateway.example/v1", agentCode, accessKey, fetchImpl, currency: "IDR", maxMinor: 10000000 });
  await client.createCheckout({ orderid: "IDRabc12345", amountLkrMinor: 5000000 });
  assert.deepEqual(sent[0], { orderid: "IDRabc12345", currency: "IDR", amount: 50000 });
  await assert.rejects(client.createCheckout({ orderid: "IDRabc12345", amountLkrMinor: 10000001 }), /Invalid RameeGlobalPay deposit/);
});

test("IDR checkout errors include the gateway's JSON message; LKR stays bare", async () => {
  const { agentCode, accessKey } = { agentCode: "A".repeat(16), accessKey: "k".repeat(32) };
  const reply = async () => Response.json({ success: false, message: "Currency IDR not enabled\nfor agent" }, { status: 400 });
  const opts = { baseUrl: "https://gateway.example/v1", agentCode, accessKey, fetchImpl: reply };
  const idr = createLkrClient({ ...opts, currency: "IDR", httpErrorDetail: true });
  await assert.rejects(idr.createCheckout({ orderid: "IDRabc12345", amountLkrMinor: 100 }),
    /^Error: RameeGlobalPay request returned HTTP 400\. Gateway said: Currency IDR not enabled for agent$/);
  const lkr = createLkrClient(opts);
  await assert.rejects(lkr.createCheckout({ orderid: "LKRabc12345", amountLkrMinor: 100 }),
    /^Error: RameeGlobalPay request returned HTTP 400\.$/);
});

test("IDR stays off unless explicitly enabled and shares the dedicated-provider guard", () => {
  assert.equal(idrClient({}), null);
  assert.equal(idrClient({ RAMEE_GLOBAL_IDR_ENABLED: "True" }), null);
  const client = idrClient({
    RAMEE_GLOBAL_IDR_ENABLED: "true", RAMEE_GLOBAL_LKR_API_BASE: "https://gateway.example/v1",
    RAMEE_GLOBAL_LKR_AGENT_CODE: agentCode, RAMEE_GLOBAL_LKR_ACCESS_KEY: accessKey,
  });
  assert.equal(typeof client.createCheckout, "function");
  assert.throws(() => idrClient({ RAMEE_GLOBAL_IDR_ENABLED: "true", RAMEE_GLOBAL_IDR_MAX_AMOUNT: "abc" }));
  assert.ok(DEDICATED_DEPOSIT_PROVIDERS.includes("RAMEE_GLOBAL_LKR") && DEDICATED_DEPOSIT_PROVIDERS.includes("RAMEE_GLOBAL_IDR"));
});
