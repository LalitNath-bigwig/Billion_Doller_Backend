const test = require("node:test");
const assert = require("node:assert/strict");
const { createLkrSandbox } = require("../integrations/sandbox/lkrPaymentFlow");
const { createCipher } = require("../integrations/sandbox/rameeGlobalLkrPayin");
const { connectRameeGlobalLkrPayout } = require("../integrations/sandbox/rameeGlobalLkrPayout");

const agentCode = "TESTAGENT0000001";
const accessKey = "0123456789abcdef0123456789abcdef";
const providerId = "OLKRTest0001";
const cipher = createCipher(accessKey);
const testBank = { code: "TESTBANK", account: "0012345678" };

function setup({ resolve = "approve", responder } = {}) {
  const flow = createLkrSandbox({ lkrMinorPerUsd: 30000, openingUsdCents: 10000 });
  const order = flow.requestWithdrawal(600000);
  if (resolve) flow.resolveWithdrawal(order.id, resolve);
  const requests = [];
  const payout = connectRameeGlobalLkrPayout({
    flow, agentCode, accessKey,
    async post(path, request) {
      assert.deepEqual(request.headers, { "X-Agent-Code": agentCode, "Content-Type": "application/json" });
      assert.deepEqual(Object.keys(request.body), ["data"]);
      const body = cipher.decrypt(request.body.data);
      requests.push({ path, body });
      return responder?.({ path, body, order });
    },
  });
  const acceptance = { success: true, merchantid: order.id, orderid: providerId, status: "INITIATED" };
  function callback(overrides = {}) {
    return { agentCode, data: cipher.encrypt({ service: "PayOut", merchantid: order.id, orderid: providerId,
      amount: "6000.00", status: "SUCCESS", ...overrides }) };
  }
  return { flow, order, payout, acceptance, callback, requests };
}

test("payout methods lookup uses LKR and the encrypted request envelope", async () => {
  const methods = [{ id: 1, code: "TESTBANK", description: "Test Bank" }];
  const { payout, requests } = setup({ responder: () => ({ success: true, methods }) });
  assert.deepEqual(await payout.listMethods(), methods);
  assert.deepEqual(requests, [{ path: "/payout/methods", body: { currency: "LKR" } }]);
});

test("payout acceptance requires approval and unique bound references", () => {
  const pending = setup({ resolve: null });
  assert.throws(() => pending.payout.recordAcceptance(pending.order.id, pending.acceptance), /Approve the LKR test withdrawal/);
  const { flow, order, payout, acceptance, callback } = setup();
  assert.throws(() => payout.applyCallback(callback()), /does not match the withdrawal references/);
  assert.throws(() => payout.recordAcceptance(order.id, { ...acceptance, merchantid: "other" }), /Invalid/);
  assert.equal(payout.recordAcceptance(order.id, acceptance), providerId);
  assert.equal(payout.recordAcceptance(order.id, acceptance), providerId);
  assert.throws(() => payout.recordAcceptance(order.id, { ...acceptance, orderid: "OLKRTest0002" }), /Conflicting/);
  const second = flow.requestWithdrawal(600000);
  flow.resolveWithdrawal(second.id, "approve");
  assert.throws(() => payout.recordAcceptance(second.id, { ...acceptance, merchantid: second.id }), /Conflicting/);
});

test("the THB sample with LKR sends the approved amount and exact bank fields once", async () => {
  const { flow, order, payout, requests, callback } = setup({ responder({ path, order }) {
    if (path === "/payout/methods") return { success: true, methods: [{ code: testBank.code }] };
    return { success: true, merchantid: order.id, orderid: providerId, status: "INITIATED" };
  } });
  const outcomes = await Promise.allSettled([
    payout.submitWithdrawal(order.id, testBank),
    payout.submitWithdrawal(order.id, testBank),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.match(outcomes.find(outcome => outcome.status === "rejected").reason.message, /existing payout status/);
  assert.deepEqual(requests.filter(request => request.path === "/payout/request"), [{
    path: "/payout/request",
    body: { currency: "LKR", amount: 6000, orderid: order.id, orderDetail: testBank },
  }]);
  assert.deepEqual(flow.balance(), { availableUsdCents: 8000n, reservedUsdCents: 2000n });
  assert.equal(payout.applyCallback(callback()).status, "succeeded");
  assert.deepEqual(flow.balance(), { availableUsdCents: 8000n, reservedUsdCents: 0n });
});

test("a bank code missing from the LKR methods list prevents submission", async () => {
  const { order, payout, requests } = setup({ responder: () => ({ success: true, methods: [] }) });
  await assert.rejects(payout.submitWithdrawal(order.id, testBank), /not available for LKR/);
  assert.deepEqual(requests, [{ path: "/payout/methods", body: { currency: "LKR" } }]);
});

test("an ambiguous submission keeps the reserve and checks the original reference without resending", async () => {
  let lookup;
  const { flow, order, payout, requests } = setup({ responder({ path }) {
    if (path === "/payout/methods") return { success: true, methods: [{ code: testBank.code }] };
    if (path === "/payout/request") return { success: false, message: "Withdrawal Request Failed.." };
    return lookup;
  } });
  await assert.rejects(payout.submitWithdrawal(order.id, testBank), /submission is unconfirmed/);
  await assert.rejects(payout.submitWithdrawal(order.id, testBank), /existing payout status/);
  lookup = { success: false, message: "Invalid Transaction Id." };
  await assert.rejects(payout.refreshWithdrawal(order.id), /did not confirm/);
  assert.deepEqual(flow.balance(), { availableUsdCents: 8000n, reservedUsdCents: 2000n });
  lookup = { success: true, orderId: order.id, systemId: providerId, status: "SUCCESS" };
  assert.equal((await payout.refreshWithdrawal(order.id)).status, "succeeded");
  assert.deepEqual(requests.at(-1), { path: "/payout/status", body: { orderid: order.id } });
  assert.equal(requests.filter(request => request.path === "/payout/request").length, 1);
});

test("an authenticated payout callback with matching amount settles the reserve once", () => {
  const { flow, order, payout, acceptance, callback } = setup();
  payout.recordAcceptance(order.id, acceptance);
  assert.equal(payout.applyCallback(callback({ status: "PENDING" })).status, "processing");
  assert.deepEqual(flow.balance(), { availableUsdCents: 8000n, reservedUsdCents: 2000n });
  assert.equal(payout.applyCallback(callback()).status, "succeeded");
  assert.equal(payout.applyCallback(callback()).status, "succeeded");
  assert.throws(() => payout.applyCallback(callback({ status: "REFUNDED" })), /Reconcile/);
  assert.deepEqual(flow.balance(), { availableUsdCents: 8000n, reservedUsdCents: 0n });
});

test("tampered callbacks and mismatched amounts, currency, or references cannot settle a payout", () => {
  const { flow, order, payout, acceptance, callback } = setup();
  payout.recordAcceptance(order.id, acceptance);
  const original = callback();
  const tampered = Buffer.from(original.data, "base64");
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => payout.applyCallback({ ...original, data: tampered.toString("base64") }));
  assert.throws(() => payout.applyCallback({ ...original, agentCode: "OTHERAGENT000001" }), /agent does not match/);
  for (const invalid of [{ amount: "6000.01" }, { currency: "BDT" }, { service: "PayIn" }, { orderid: "wrong" }]) {
    assert.throws(() => payout.applyCallback(callback(invalid)));
  }
  assert.deepEqual(flow.balance(), { availableUsdCents: 8000n, reservedUsdCents: 2000n });
});

test("uncertain or unbound payout statuses keep funds reserved until lookup confirms both references", async () => {
  let response = { success: false, message: "Invalid Transaction Id." };
  const { flow, order, payout, acceptance, requests } = setup({ responder: () => response });
  payout.recordAcceptance(order.id, acceptance);
  await assert.rejects(payout.refreshWithdrawal(order.id), /did not confirm/);
  response = { success: true, orderId: "other", systemId: providerId, status: "SUCCESS" };
  await assert.rejects(payout.refreshWithdrawal(order.id), /requested withdrawal/);
  response = { ...response, orderId: order.id, systemId: "other" };
  await assert.rejects(payout.refreshWithdrawal(order.id), /withdrawal references/);
  response = { ...response, systemId: providerId, status: "PENDING" };
  assert.equal((await payout.refreshWithdrawal(order.id)).status, "processing");
  assert.deepEqual(flow.balance(), { availableUsdCents: 8000n, reservedUsdCents: 2000n });
  response = { ...response, status: "SUCCESS" };
  assert.equal((await payout.refreshWithdrawal(order.id)).status, "succeeded");
  assert.deepEqual(requests.at(-1), { path: "/payout/status", body: { orderid: order.id } });
  assert.deepEqual(flow.balance(), { availableUsdCents: 8000n, reservedUsdCents: 0n });
});

test("a payout confirmed failed or refunded releases the reservation once", () => {
  for (const status of ["FAILED", "REFUNDED"]) {
    const { flow, order, payout, acceptance, callback } = setup();
    payout.recordAcceptance(order.id, acceptance);
    assert.equal(payout.applyCallback(callback({ status })).status, "failed");
    assert.equal(payout.applyCallback(callback({ status })).status, "failed");
    assert.deepEqual(flow.balance(), { availableUsdCents: 10000n, reservedUsdCents: 0n });
  }
});
