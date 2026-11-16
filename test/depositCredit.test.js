const test = require("node:test");
const assert = require("node:assert/strict");
const { createGuard, balanceWithClaim, checkDepositReadiness, LKR_DEPOSIT_PROVIDER } = require("../services/depositCredit.service");
const { createLkrDepositService } = require("../services/rameeGlobalLkrDeposit.service");
const { createLkrClient } = require("../utils/rameeGlobalLkrClient");
const { createCipher } = require("../utils/rameeGlobalProtocol");

function storage(patch = {}) {
  const record = { _id: "db1", orderid: "ORD1", accountNo: "1001", provider: "CREGIS", amount: 100, creditedAmount: 0, status: "PENDING", ...patch };
  function matches(filter) {
    return Object.entries(filter).every(([key, expected]) => {
      if (key === "$or") return expected.some(matches);
      const actual = key.split(".").reduce((obj, key) => obj?.[key], record);
      if (typeof expected?.$exists === "boolean") return (actual !== undefined) === expected.$exists;
      return expected?.$ne ? actual !== expected.$ne : expected?.$nin ? !expected.$nin.includes(actual) : expected?.$in ? expected.$in.includes(actual) : actual === expected;
    });
  }
  const doc = () => ({ ...structuredClone(record), save: async function() {
    record.status = this.status;
    record.creditedAmount = this.creditedAmount;
    if (this.providerOrderId !== undefined) record.providerOrderId = this.providerOrderId;
  } });
  function apply(update) {
    for (const [key, value] of Object.entries(update.$set || {})) {
      const path = key.split("."); let obj = record;
      for (const part of path.slice(0, -1)) obj = obj[part] ||= {};
      obj[path.at(-1)] = structuredClone(value);
    }
    for (const key of Object.keys(update.$unset || {})) delete record[key];
  }
  return {
    record,
    create: async ([order]) => { Object.assign(record, order); return [doc()]; },
    collection: { indexes: async () => [{ key: { orderid: 1 }, unique: true }] },
    findOne: async filter => matches(filter) ? doc() : null,
    findOneAndUpdate: async (filter, update) => { if (!matches(filter)) return null; apply(update); return doc(); },
    updateOne: async (filter, update) => {
      if (!matches(filter)) return { matchedCount: 0, modifiedCount: 0 };
      apply(update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}
function harness({ patch, updateBalance } = {}) {
  const orders = storage(patch); const credits = []; const errors = [];
  const guard = createGuard({ orders, updateBalance: updateBalance || (async options => { credits.push(options); return { retcode: "0 Done", ticket: "123" }; }), logger: { error: value => errors.push(value) } });
  const pay = (amount, status = "SUCCESS") => guard.run("ORD1", async order => {
    const result = await balanceWithClaim({ login: order.accountNo, type: 2, balance: amount, comment: "existing-provider-comment" });
    assert.equal(result.retcode, "0 Done");
    order.creditedAmount += Number(amount); order.status = status; await order.save();
  });
  return { orders, guard, credits, errors, pay };
}

test("repeated callbacks never submit another credit, including legacy successful orders", async () => {
  const h = harness(); await h.pay(100); await h.pay(100);
  assert.equal(h.credits.length, 1); assert.equal(h.orders.record.creditedAmount, 100);
  const legacy = harness({ patch: { status: "SUCCESS", creditedAmount: 0 } }); await legacy.pay(100);
  assert.equal(legacy.credits.length, 0);
});

test("LKR checkout saves the quote and settles only the bound, encrypted callback", async () => {
  const { orders, guard, credits } = harness();
  const accessKey = "0123456789abcdef0123456789abcdef";
  const agentCode = "TESTAGENT0000001";
  const cipher = createCipher(accessKey);
  const providerId = "GLKR00001";
  const client = createLkrClient({
    baseUrl: "https://ramee.example.invalid/v1", agentCode, accessKey,
    async fetchImpl(url, options) {
      assert.equal(url.pathname, "/v1/order/generate");
      const payload = cipher.decrypt(JSON.parse(options.body).data);
      assert.deepEqual(payload, { currency: "LKR", amount: 30000.50, orderid: orders.record.orderid });
      assert.equal(orders.record.amount, 100);
      return Response.json({ success: true, merchantid: payload.orderid, orderid: providerId, url: "https://checkout.example.invalid/test" });
    },
  });
  const service = createLkrDepositService({ client, orders, runDeposit: guard.run, balanceWithClaim });
  const deposit = await service.createDeposit({ account: { _id: "account", accountNo: "1001" }, amountLkrMinor: 3000050, lkrMinorPerUsd: 30000 });
  assert.equal(orders.record.provider, LKR_DEPOSIT_PROVIDER);
  assert.equal(orders.record.providerOrderId, providerId);
  assert.match(deposit.orderid, /^[a-zA-Z0-9]{35}$/);
  assert.deepEqual(orders.record.rameeGlobalLkr, { amountLkrMinor: 3000050, lkrMinorPerUsd: 30000 });
  await assert.rejects(guard.run(deposit.orderid, () => assert.fail("A legacy rail claimed an LKR order")), /requires reconciliation/);
  assert.equal(credits.length, 0);
  const event = { service: "PayIn", currency: "LKR", merchantid: deposit.orderid, orderid: providerId, amount: "30000.50", status: "SUCCESS" };
  const decode = payload => client.decodeDepositCallback({ agentCode, data: cipher.encrypt(payload) });
  assert.throws(() => decode({ ...event, service: "PayOut" }), /Invalid LKR deposit callback/);
  await assert.rejects(service.applyCallback(decode({ ...event, amount: "30000.49" })), /does not match/);
  assert.equal(credits.length, 0);
  assert.equal(await service.applyCallback(decode(event)), "SUCCESS");
  assert.equal(await service.applyCallback(decode({ ...event, status: "SETTLED" })), "SUCCESS");
  assert.equal(credits.length, 1);
  assert.equal(orders.record.creditedAmount, 100);
});

test("LKR status lookup recovers a missing checkout reference without trusting an unbound callback", async () => {
  const { orders, guard, credits } = harness({ patch: {
    provider: LKR_DEPOSIT_PROVIDER, rameeGlobalLkr: { amountLkrMinor: 3000000, lkrMinorPerUsd: 30000 },
  } });
  const event = { merchantid: "ORD1", orderid: "GLKR00001", amount: "30000.00", status: "SUCCESS" };
  const client = { async depositStatus(id) { assert.equal(id, "ORD1"); return event; } };
  const service = createLkrDepositService({ client, orders, runDeposit: guard.run, balanceWithClaim });
  await assert.rejects(service.applyCallback(event), /does not match/);
  assert.equal(credits.length, 0);
  assert.equal(await service.refresh("ORD1"), "SUCCESS");
  assert.equal(await service.applyCallback(event), "SUCCESS");
  assert.equal(orders.record.providerOrderId, event.orderid);
  assert.equal(credits.length, 1);
});

test("unavailable LKR payouts exit before the existing withdrawal path", () => {
  const { requireSupportedWithdrawalCurrency } = require("../controllers/payments/rameeGlobalLkr.controller");
  const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  for (const currency of ["LKR", "lkr", " LKr "]) {
    requireSupportedWithdrawalCurrency({ body: { currency } }, response, () => assert.fail("LKR reached the withdrawal path"));
    assert.equal(response.code, 503);
  }
  let existingRequests = 0;
  for (const currency of ["INR", "VND", "CRYPTO", "USD", undefined]) {
    requireSupportedWithdrawalCurrency({ body: { currency } }, response, () => existingRequests++);
  }
  assert.equal(existingRequests, 5);
});
test("simultaneous callbacks and reconciliation use one database claim", async () => {
  let release; let enter;
  const entered = new Promise(resolve => enter = resolve); const wait = new Promise(resolve => release = resolve);
  const credits = [];
  const h = harness({ updateBalance: async options => { credits.push(options); enter(); await wait; return { retcode: 0 }; } });
  const first = h.pay(100); await entered;
  await assert.rejects(h.pay(100), /processed or requires reconciliation/);
  release(); await first; await h.pay(100);
  assert.equal(credits.length, 1);
});
test("partial, repeated partial and top-up events use freshly claimed cumulative state", async () => {
  const h = harness();
  async function cumulative(total, status) {
    await h.guard.run("ORD1", async order => {
      const delta = total - order.creditedAmount;
      if (delta > 0) await balanceWithClaim({ login: order.accountNo, type: 2, balance: delta });
      order.creditedAmount = total; order.status = status; await order.save();
    });
  }
  await cumulative(25, "PARTIALLY_PAID"); await cumulative(25, "PARTIALLY_PAID"); await cumulative(105, "SUCCESS"); await cumulative(105, "SUCCESS");
  assert.deepEqual(h.credits.map(x => x.balance), [25, 80]); assert.equal(h.orders.record.creditedAmount, 105);
});
test("a lost MT5 reply leaves a persistent review claim and cannot auto-retry", async () => {
  let calls = 0;
  const h = harness({ updateBalance: async () => { calls++; throw new Error("reply lost"); } });
  await assert.rejects(h.pay(100), /reply lost/);
  assert.equal(h.orders.record.settlementAttempt.state, "review");
  await assert.rejects(h.pay(100), /processed or requires reconciliation/); assert.equal(calls, 1);
});
test("failure saving after a successful MT5 credit cannot lead to a second credit", async () => {
  const h = harness();
  await assert.rejects(h.guard.run("ORD1", async () => {
    await balanceWithClaim({ login: "1001", type: 2, balance: "100.00" }); throw new Error("save failed");
  }), /save failed/);
  assert.equal(h.orders.record.settlementAttempt.state, "review");
  await assert.rejects(h.pay(100)); assert.equal(h.credits.length, 1);
});
test("a persisted claim survives a restart and no balance call can run outside a claim", async () => {
  await assert.rejects(balanceWithClaim({ login: "1001", balance: 100 }), /claim is required/);
  for (const state of ["processing", "submitting", "review"]) {
    const h = harness({ patch: { settlementAttempt: { state, token: "old-worker" } } });
    await assert.rejects(h.pay(100)); assert.equal(h.credits.length, 0);
  }
});
test("validation/pre-credit failures release the claim, while an invalid MT5 result requires review", async () => {
  const h = harness();
  await assert.rejects(h.guard.run("ORD1", async () => { throw new Error("provider validation failed"); }));
  assert.equal(h.orders.record.settlementAttempt, undefined);
  await assert.rejects(h.guard.run("ORD1", async () => balanceWithClaim({ login: "another-account", type: 2, balance: 100 })));
  assert.equal(h.credits.length, 0);
  const bad = harness({ updateBalance: async () => ({ retcode: "01" }) }); await assert.rejects(bad.pay(100));
  assert.equal(bad.orders.record.settlementAttempt.state, "review");
});
test("one callback cannot issue two credits even before it saves status", async () => {
  const h = harness();
  await assert.rejects(h.guard.run("ORD1", async () => {
    await balanceWithClaim({ login: "1001", type: 2, balance: 100 });
    await balanceWithClaim({ login: "1001", type: 2, balance: 100 });
  }), /cannot submit two/);
  assert.equal(h.credits.length, 1); assert.equal(h.orders.record.settlementAttempt.state, "review");
});
test("missing or partial order uniqueness indexes block credit before a claim or balance call", async () => {
  for (const index of [{ key: { orderid: 1 } }, { key: { orderid: 1 }, unique: true, partialFilterExpression: { status: "PENDING" } }]) {
    const h = harness(); h.orders.collection.indexes = async () => [index];
    await assert.rejects(h.pay(100), /uniqueness index/);
    assert.equal(h.credits.length, 0); assert.equal(h.orders.record.settlementAttempt, undefined);
  }
});
test("startup preflight inspects connected storage without reusing a cached Model.init failure", async () => {
  let checked = 0;
  await checkDepositReadiness({ guard: { checkReadiness: async () => { checked++; } } });
  assert.equal(checked, 1);
  await assert.rejects(checkDepositReadiness({ guard: { checkReadiness: async () => { throw new Error("missing unique index"); } } }), /unique index/);
});
test("closed gateways refuse deposits and callbacks without loading financial services", async () => {
  for (const [file, names] of [
    ["digipay", ["handleDigipayDeposit", "handlePaymentCallback"]],
    ["trustpay24", ["handleTrustpay24Deposit", "handleTrustpay24Callback"]],
    ["truepay9", ["handleTruepay9Callback"]],
  ]) {
    const controller = require(`../controllers/payments/${file}.controller`);
    for (const name of names) {
      const res = { status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } };
      await controller[name]({ body: { amount: 100, transaction: { status: "completed" } } }, res);
      assert.equal(res.code, 410); assert.equal(res.value.status, "UNAVAILABLE");
    }
  }
});
test("all three active callback handlers use the same guard and repeated notices do not double credit", async () => {
  const Module = require("node:module");
  for (const [file, handler, payload, provider] of [
    ["rameePay", "handleRameeCallback", { data: "mock", agentCode: "mock" }, "RAMEE"],
    ["crypto", "handleCryptoCallback", { data: "mock", agentCode: "mock" }, "CRYPTO"],
    ["cregis", "handleCregisCallback", { event_type: "paid", data: JSON.stringify({ order_id: "ORD1", cregis_id: "po123", pay_amount: "100", pay_currency: "USDT" }) }, "CREGIS"],
  ]) {
    const h = harness({ patch: { provider, providerOrderId: "po123" } });
    const original = Module._load;
    const path = require.resolve(`../controllers/payments/${file}.controller`); delete require.cache[path];
    Module._load = function(request, ...args) {
      if (request === "../../services/depositCredit.service") return { runDeposit: h.guard.run, balanceWithClaim };
      if (request === "../../models/Order") return h.orders;
      if (request === "../../models/withdrawal") return { findOne: async () => null };
      if (request === "../../models/account.model") return { findOne: () => ({ populate: async () => null }) };
      if (request === "../../utils/rameeCrypto") return { decryptData: () => ({ merchantid: "ORD1", orderid: "ORD1", status: "SUCCESS", amount: "100", payAmount: "100" }), decryptDataCrypto: () => ({ orderid: "ORD1", status: "SUCCESS", amount: "100", payAmount: "100" }) };
      if (request === "../payout.controller") return { sendSuccessEmail: async () => {} };
      if (request === "../../utils/sendEmail") return async () => {};
      if (request === "./fetchRate") return async () => 1;
      return original.call(this, request, ...args);
    };
    let controller;
    try { controller = require(path); } finally { Module._load = original; }
    for (let i = 0; i < 2; i++) {
      const res = { status(code) { this.code = code; return this; }, type(value) { this.contentType = value; return this; }, json(value) { this.value = value; return this; }, send(value) { this.value = value; return this; } };
      await controller[handler]({ body: payload }, res);
      assert.equal(res.code, 200, file);
    }
    assert.equal(h.credits.length, 1, file); assert.equal(h.orders.record.creditedAmount, 100, file);
    assert.equal(h.orders.record.status, "SUCCESS", file);
  }
});

function callbackHarness(provider, options = {}) {
  const h = harness({ ...options, patch: { provider: provider === "crypto" ? "CRYPTO" : "CREGIS", providerOrderId: "po123", ...options.patch } });
  const Module = require("node:module"), original = Module._load;
  const path = require.resolve(`../controllers/payments/${provider}.controller`);
  delete require.cache[path];
  Module._load = function(request, ...args) {
    if (request === "../../services/depositCredit.service") return { runDeposit: h.guard.run, balanceWithClaim };
    if (request === "../../models/Order") return h.orders;
    if (request === "../../models/withdrawal") return { findOne: options.findWithdrawal || (async () => null) };
    if (request === "../../models/account.model") return { findOne: () => ({ populate: async () => null }) };
    if (request === "../../utils/rameeCrypto") return { decryptDataCrypto: () => ({ orderid: "ORD1", status: "SUCCESS", payAmount: "100" }) };
    if (request === "../payout.controller") return { sendSuccessEmail: async () => {} };
    if (request === "../../utils/sendEmail") return async () => {};
    if (request === "./fetchRate") return async () => 1;
    return original.call(this, request, ...args);
  };
  let controller;
  try { controller = require(path); } finally { Module._load = original; }
  h.deliver = async (body = provider === "crypto" ? { data: "test", agentCode: "test" } :
    { event_type: "paid", data: { order_id: "ORD1", pay_amount: "100", pay_currency: "USDT" } }) => {
    let sent = false;
    const res = {
      code: 200,
      status(code) { assert.equal(sent, false); this.code = code; return this; },
      type(value) { assert.equal(sent, false); this.contentType = value; return this; },
      json(value) { return this.send(value); },
      send(value) { assert.equal(sent, false); sent = true; this.value = value; this.stateAtReply = structuredClone(h.orders.record); return this; },
    };
    await controller[provider === "crypto" ? "handleCryptoCallback" : "handleCregisCallback"]({ body }, res);
    assert.equal(sent, true);
    return res;
  };
  return h;
}

for (const provider of ["crypto", "cregis"]) {
  test(`${provider} acknowledges only after the durable credit is finalized`, async () => {
    const h = callbackHarness(provider);
    const res = await h.deliver();
    assert.equal(res.code, 200);
    assert.equal(res.stateAtReply.status, "SUCCESS");
    assert.equal(res.stateAtReply.creditedAmount, 100);
    assert.equal(res.stateAtReply.settlementAttempt, undefined);
    if (provider === "cregis") { assert.equal(res.value, "success"); assert.equal(res.contentType, "text/plain"); }
    await h.deliver(); assert.equal(h.credits.length, 1);
  });
  test(`${provider} lost MT5 replies return failure and retries cannot credit again`, async () => {
    let calls = 0;
    const h = callbackHarness(provider, { updateBalance: async () => { calls++; throw new Error("reply lost"); } });
    for (let n = 0; n < 2; n++) {
      const res = await h.deliver(); assert.equal(res.code, 503);
      if (provider === "cregis") assert.equal(res.value, "failed");
      else assert.equal(res.value.success, false);
    }
    assert.equal(h.orders.record.settlementAttempt.state, "review"); assert.equal(calls, 1);
  });
  test(`${provider} rejects an unsuccessful MT5 result and retains the credit claim`, async () => {
    let calls = 0;
    const h = callbackHarness(provider, { updateBalance: async () => { calls++; return { retcode: "10013" }; } });
    assert.equal((await h.deliver()).code, 503);
    assert.equal((await h.deliver()).code, 503);
    assert.equal(calls, 1); assert.equal(h.orders.record.settlementAttempt.state, "review");
  });
  test(`${provider} never acknowledges when the final majority write fails`, async () => {
    const h = callbackHarness(provider), write = h.orders.updateOne;
    h.orders.updateOne = async (filter, update, opts) => {
      if (update.$unset?.settlementAttempt && update.$set?.creditedAmount !== undefined) throw new Error("storage unavailable");
      return write(filter, update, opts);
    };
    assert.equal((await h.deliver()).code, 503);
    assert.equal((await h.deliver()).code, 503);
    assert.equal(h.credits.length, 1);
    assert.equal(h.orders.record.settlementAttempt.state, "submitting");
  });
  test(`${provider} an order save failure after MT5 success requires reconciliation`, async () => {
    const h = callbackHarness(provider), read = h.orders.findOne;
    h.orders.findOne = async filter => {
      const doc = await read(filter);
      if (doc && !filter["settlementAttempt.token"]) doc.save = async () => { throw new Error("save failed"); };
      return doc;
    };
    assert.equal((await h.deliver()).code, 503);
    assert.equal((await h.deliver()).code, 503);
    assert.equal(h.credits.length, 1);
    assert.equal(h.orders.record.settlementAttempt.state, "review");
  });
}

test("Cregis invalid input and failed payout writes are never acknowledged as success", async () => {
  const invalid = callbackHarness("cregis");
  for (const body of [undefined, {}, { event_type: "paid", data: "{" }, { event_type: "paid", data: {} }]) {
    const res = await invalid.deliver(body === undefined ? null : body);
    assert.equal(res.code, 400); assert.equal(res.value, "failed");
  }
  const h = callbackHarness("cregis", { findWithdrawal: async () => ({
    status: "Processing", save: async () => { throw new Error("database unavailable"); },
  }) });
  const res = await h.deliver({ third_party_id: "PAYOUT1", status: 6 });
  assert.equal(res.code, 503); assert.equal(res.value, "failed");
  assert.equal(h.credits.length, 0);
});
module.exports = { storage };
