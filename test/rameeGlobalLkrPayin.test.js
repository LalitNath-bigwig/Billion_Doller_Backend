const test = require("node:test");
const assert = require("node:assert/strict");
const { createDecipheriv } = require("node:crypto");
const { createLkrSandbox } = require("../integrations/sandbox/lkrPaymentFlow");
const { connectRameeGlobalLkrPayin, createCipher } = require("../integrations/sandbox/rameeGlobalLkrPayin");

const agentCode = "TESTAGENT0000001";
const testKey = "0123456789abcdef0123456789abcdef";
const providerId = "GLKRTest0001";
const checkoutUrl = "https://ramee.example.invalid/checkout/test";

function setup(responder) {
  const flow = createLkrSandbox({ lkrMinorPerUsd: 30000 });
  const order = flow.createDeposit(3000050);
  const cipher = createCipher(testKey);
  const requests = [];
  const payin = connectRameeGlobalLkrPayin({ flow, agentCode, accessKey: testKey,
    post: async (path, request) => {
      assert.deepEqual(request.headers, { "X-Agent-Code": agentCode, "Content-Type": "application/json" });
      assert.deepEqual(Object.keys(request.body), ["data"]);
      // Decode with the wire offsets directly to check the documented layout.
      const bytes = Buffer.from(request.body.data, "base64");
      const decrypt = createDecipheriv("aes-256-gcm", Buffer.from(testKey), bytes.subarray(0, 12));
      decrypt.setAuthTag(bytes.subarray(12, 28));
      const payload = JSON.parse(Buffer.concat([decrypt.update(bytes.subarray(28)), decrypt.final()]));
      requests.push({ path, payload });
      return responder?.(path) ?? { success: true, merchantid: order.id, orderid: providerId, url: checkoutUrl };
    },
  });
  function event(status = "SUCCESS", overrides = {}) {
    return { agentCode, data: cipher.encrypt({ service: "PayIn", currency: "LKR", orderid: providerId,
      merchantid: order.id, amount: "30000.50", status, ...overrides }) };
  }
  return { flow, order, payin, requests, event };
}

test("pay-in sends encrypted LKR to the documented checkout path with an alphanumeric reference", async () => {
  const { payin, order, requests } = setup();
  const expected = { checkoutUrl, providerId };
  assert.deepEqual(await payin.createCheckout(order), expected);
  assert.deepEqual(await payin.createCheckout(order), expected);
  assert.deepEqual(requests, [{ path: "/order/generate", payload: { currency: "LKR", amount: 30000.5, orderid: order.id } }]);
  assert.match(order.id, /^[a-zA-Z0-9]{4,35}$/);
});

test("SUCCESS and SETTLED callbacks only credit the test wallet once", async () => {
  const { payin, order, flow, event } = setup();
  await payin.createCheckout(order);
  assert.equal(payin.applyCallback(event("PENDING")).status, "awaiting_payment");
  assert.equal(flow.balance().availableUsdCents, 0n);
  assert.equal(payin.applyCallback(event()).status, "succeeded");
  assert.equal(payin.applyCallback(event("SETTLED")).status, "succeeded");
  assert.equal(flow.balance().availableUsdCents, 10000n);
});

test("tampered and mismatched callbacks leave the test wallet unchanged", async () => {
  const { payin, order, flow, event } = setup();
  await payin.createCheckout(order);
  const original = event();
  const tampered = Buffer.from(original.data, "base64");
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => payin.applyCallback({ ...original, data: tampered.toString("base64") }));
  assert.throws(() => payin.applyCallback({ ...original, agentCode: "OTHERAGENT000001" }), /agent does not match/);
  for (const invalid of [{ currency: "THB" }, { service: "PayOut" }, { amount: "30000.49" }, { orderid: "wrong" }]) {
    assert.throws(() => payin.applyCallback(event("SUCCESS", invalid)));
  }
  assert.equal(flow.balance().availableUsdCents, 0n);
});

test("status lookup reconciles a missed callback with the bound merchant and provider references", async () => {
  const run = setup(path => path === "/order/status"
    ? { orderid: providerId, merchantid: run.order.id, amount: "30000.50", status: "SUCCESS" }
    : undefined);
  await run.payin.createCheckout(run.order);
  assert.equal((await run.payin.refreshDeposit(run.order.id)).status, "succeeded");
  assert.deepEqual(run.requests.at(-1), { path: "/order/status", payload: { orderid: providerId } });
  assert.equal(run.flow.balance().availableUsdCents, 10000n);
});

test("provider rejection or failed callback never credits a deposit", async () => {
  const rejected = setup(() => ({ success: false }));
  await assert.rejects(rejected.payin.createCheckout(rejected.order), /did not confirm/);
  const { payin, flow, order, event } = setup();
  await payin.createCheckout(order);
  assert.equal(payin.applyCallback(event("FAILED")).status, "failed");
  assert.equal(flow.balance().availableUsdCents, 0n);
});
