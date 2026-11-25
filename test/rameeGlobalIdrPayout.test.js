const test = require("node:test");
const assert = require("node:assert/strict");
const { createIdrPayoutService, readIdrPayoutConfig } = require("../services/rameeGlobalIdrPayout.service");
const { createCipher } = require("../utils/rameeGlobalProtocol");

const agentCode = "IDRAGENTCODE0001";
const accessKey = "0123456789abcdef0123456789abcdef";
const env = {
  RAMEE_GLOBAL_IDR_ENABLED: "true",
  RAMEE_GLOBAL_IDR_AGENT_CODE: agentCode,
  RAMEE_GLOBAL_IDR_ACCESS_KEY: accessKey,
  RAMEE_GLOBAL_IDR_PER_USD: "16000",
};
const cipher = createCipher(accessKey);
const methods = [{ id: 147, code: "BANK_BRI", description: "Bank BRI" }, { id: 153, code: "BANK_BCA", description: "Bank BCA" }];

// Minimal in-memory stand-in for the Withdrawal model (dotted paths, $in, $or, $set).
function fakeWithdrawals(seed) {
  const docs = [seed];
  const get = (doc, path) => path.split(".").reduce((value, key) => value?.[key], doc);
  const set = (doc, path, value) => {
    const keys = path.split(".");
    const last = keys.pop();
    const holder = keys.reduce((node, key) => (node[key] ??= {}), doc);
    holder[last] = value;
  };
  const matches = (doc, filter) => Object.entries(filter).every(([key, want]) => {
    if (key === "$or") return want.some(branch => matches(doc, branch));
    const have = get(doc, key);
    return want && typeof want === "object" && "$in" in want ? want.$in.includes(have) : have === want;
  });
  const apply = (doc, update) => { for (const [path, value] of Object.entries(update.$set || {})) set(doc, path, value); return doc; };
  return {
    docs,
    async findOne(filter) { return docs.find(doc => matches(doc, filter)) || null; },
    async findOneAndUpdate(filter, update) { const doc = docs.find(d => matches(d, filter)); return doc ? apply(doc, update) : null; },
    async updateOne(filter, update) { const doc = docs.find(d => matches(d, filter)); if (doc) apply(doc, update); return { modifiedCount: doc ? 1 : 0 }; },
  };
}

const newWithdrawal = (extra = {}) => ({
  _id: "w1", orderid: "WDR1700000000000", currency: "IDR", amount: 1600000, amountUSD: 100, status: "Pending",
  account: "1234567890", name: "Budi", bankName: "Bank BRI", rameeGlobalIdr: { bankCode: "BANK_BRI", attempts: 0, needsReview: false }, ...extra,
});

function setup({ withdrawal = newWithdrawal(), client = {}, envOverride = {} } = {}) {
  const withdrawals = fakeWithdrawals(withdrawal);
  const calls = [];
  const fake = {
    getPayoutMethods: async () => ({ success: true, httpStatus: 200, data: { methods } }),
    createPayout: async (params) => { calls.push(["createPayout", params]); return { success: true, httpStatus: 200, data: { orderid: "OIDR1", merchantid: params.orderid, status: "INITIATED" } }; },
    getPayoutStatus: async (orderid) => { calls.push(["getPayoutStatus", orderid]); return { success: false, httpStatus: 400, message: "Invalid Transaction Id." }; },
    decrypt: data => cipher.decrypt(data),
    ...client,
  };
  const service = createIdrPayoutService({ withdrawals, env: { ...env, ...envOverride }, makeClient: () => fake });
  return { service, withdrawals, calls, doc: withdrawals.docs[0] };
}

test("IDR payout settings are off unless enabled and must be valid", () => {
  assert.equal(readIdrPayoutConfig({}), null);
  assert.throws(() => readIdrPayoutConfig({ ...env, RAMEE_GLOBAL_IDR_PER_USD: "0" }), /PER_USD/);
  assert.throws(() => readIdrPayoutConfig({ ...env, RAMEE_GLOBAL_IDR_AGENT_CODE: "short" }), /AGENT_CODE/);
  assert.equal(readIdrPayoutConfig(env).minIdr, 10000);
});

test("the bank list returns code and description and is cached", async () => {
  let fetched = 0;
  const { service } = setup({ client: { getPayoutMethods: async () => { fetched += 1; return { success: true, httpStatus: 200, data: { methods } }; } } });
  const first = await service.loadMethods();
  await service.loadMethods();
  assert.equal(first.ok, true);
  assert.deepEqual(first.methods.map(m => m.code), ["BANK_BRI", "BANK_BCA"]);
  assert.equal(fetched, 1);
});

test("a valid request is priced in USD at the env rate, rounded up to the cent", async () => {
  const { service } = setup();
  const prepared = await service.prepareRequest({ amount: "1600001", bankCode: "BANK_BCA", account: "1234567890", accountHolderName: " Budi " });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.usd, 100.01);
  assert.equal(prepared.bankName, "Bank BCA");
  assert.equal(prepared.holder, "Budi");
});

test("requests with a bad amount, bank or account are refused before any debit", async () => {
  const { service } = setup();
  const good = { amount: 1600000, bankCode: "BANK_BRI", account: "1234567890", accountHolderName: "Budi" };
  for (const [patch, status] of [
    [{ amount: "1000.5" }, 400], [{ amount: 5000 }, 400], [{ amount: 100000001 }, 400],
    [{ bankCode: "NOT_A_BANK" }, 400], [{ bankCode: "" }, 400], [{ account: "12ab" }, 400], [{ accountHolderName: "" }, 400],
  ]) {
    const result = await service.prepareRequest({ ...good, ...patch });
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.equal(result.status, status);
  }
  assert.equal((await setup({ envOverride: { RAMEE_GLOBAL_IDR_ENABLED: "false" } }).service.prepareRequest(good)).status, 503);
});

test("approving submits the exact RameeGlobalPay payload and waits for the callback", async () => {
  const { service, calls, doc } = setup();
  const result = await service.approve(doc);
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0][1], {
    currency: "IDR", amount: 1600000, orderid: "WDR1700000000000", note: "IDR Withdrawal",
    orderDetail: { code: "BANK_BRI", account: "1234567890" },
  });
  assert.equal(doc.status, "Processing");
  assert.equal(doc.rameeGlobalIdr.payoutOrderId, "WDR1700000000000");
  assert.equal(doc.rameeGlobalIdr.needsReview, false);
});

test("an unconfirmed attempt stays Processing and is checked before anything is re-sent", async () => {
  let attempt = 0;
  const { service, calls, doc } = setup({ client: {
    createPayout: async (params) => { calls.push(["createPayout", params]); attempt += 1; return attempt === 1 ? { success: false, httpStatus: 0, message: "timeout" } : { success: true, httpStatus: 200, data: { orderid: "OIDR1", status: "INITIATED" } }; },
  } });
  const first = await service.approve(doc);
  assert.equal(first.ok, false);
  assert.equal(first.code, "UNCONFIRMED");
  assert.equal(doc.status, "Processing");
  assert.equal(doc.rameeGlobalIdr.needsReview, true);

  // Status lookup says it never existed ("Invalid Transaction Id."): same orderid is reused.
  const second = await service.approve(doc);
  assert.equal(second.ok, true);
  const sends = calls.filter(call => call[0] === "createPayout");
  assert.equal(sends.length, 2);
  assert.equal(sends[1][1].orderid, "WDR1700000000000");
});

test("a previously queued payout is not sent twice", async () => {
  const { service, calls, doc } = setup({
    withdrawal: newWithdrawal({ status: "Processing", rameeGlobalIdr: { bankCode: "BANK_BRI", payoutOrderId: "WDR1700000000000", attempts: 0, needsReview: true } }),
    client: { getPayoutStatus: async () => ({ success: true, httpStatus: 200, data: { status: "SUCCESS", utr: "UTR123" } }) },
  });
  const result = await service.approve(doc);
  assert.equal(result.ok, true);
  assert.ok(result.completed);
  assert.equal(doc.status, "Completed");
  assert.equal(doc.transactionReference, "UTR123");
  assert.equal(calls.filter(call => call[0] === "createPayout").length, 0);
});

test("after a confirmed failure the retry uses a new payout orderid", async () => {
  const { service, calls, doc } = setup({
    withdrawal: newWithdrawal({ status: "Failed", rameeGlobalIdr: { bankCode: "BANK_BRI", payoutOrderId: "WDR1700000000000", attempts: 0, needsReview: false } }),
    client: { getPayoutStatus: async () => ({ success: true, httpStatus: 200, data: { status: "FAILED" } }) },
  });
  const result = await service.approve(doc);
  assert.equal(result.ok, true);
  assert.equal(calls.find(call => call[0] === "createPayout")[1].orderid, "WDR1700000000000R1");
  assert.equal(doc.rameeGlobalIdr.attempts, 1);
});

test("a definite rejection marks the withdrawal Failed and refunds nothing", async () => {
  const { service, doc } = setup({ client: { createPayout: async () => ({ success: false, httpStatus: 400, message: "Error: Invalid bank code." }) } });
  const result = await service.approve(doc);
  assert.equal(result.ok, false);
  assert.equal(result.code, "REJECTED");
  assert.equal(doc.status, "Failed");
  assert.equal(doc.rameeGlobalIdr.needsReview, false);
});

test("a withdrawal cannot be approved twice at once", async () => {
  const { service, doc } = setup({ withdrawal: newWithdrawal({ status: "Processing" }) });
  const result = await service.approve(doc);
  assert.equal(result.ok, false);
  assert.equal(result.code, "IN_PROGRESS");
});

const envelope = (event, code = agentCode) => ({ agentCode: code, data: cipher.encrypt(event) });
const processing = () => newWithdrawal({ status: "Processing", rameeGlobalIdr: { bankCode: "BANK_BRI", payoutOrderId: "WDR1700000000000", attempts: 0, needsReview: false } });
const event = (extra = {}) => ({ service: "PayOut", amount: "1600000.00", status: "SUCCESS", orderid: "OIDR1", merchantid: "WDR1700000000000", utr: "UTR9", ...extra });

test("a SUCCESS callback completes the withdrawal once and replays are harmless", async () => {
  const { service, doc } = setup({ withdrawal: processing() });
  const first = await service.handleCallback(envelope(event()));
  assert.equal(first.status, 200);
  assert.ok(first.completed);
  assert.equal(doc.status, "Completed");
  assert.equal(doc.transactionReference, "UTR9");
  const replay = await service.handleCallback(envelope(event()));
  assert.equal(replay.status, 200);
  assert.equal(replay.completed, undefined);
});

test("FAILED and REFUNDED callbacks mark Failed without refunding", async () => {
  for (const status of ["FAILED", "REFUNDED"]) {
    const { service, doc } = setup({ withdrawal: processing() });
    const result = await service.handleCallback(envelope(event({ status })));
    assert.equal(result.status, 200);
    assert.equal(doc.status, "Failed");
    assert.equal(doc.rameeGlobalIdr.providerStatus, status);
  }
});

test("a conflicting late callback is refused", async () => {
  const { service } = setup({ withdrawal: newWithdrawal({ status: "Completed", rameeGlobalIdr: { payoutOrderId: "WDR1700000000000" } }) });
  assert.equal((await service.handleCallback(envelope(event({ status: "FAILED" })))).status, 409);
});

test("callbacks for other agents, forged data, other services or wrong amounts are not settled", async () => {
  const { service, doc } = setup({ withdrawal: processing() });
  assert.equal(await service.handleCallback(envelope(event(), "OTHERAGENTCODE01")), null);
  assert.equal(await service.handleCallback({ agentCode, data: "AAAA" }), null);
  assert.equal(await service.handleCallback(envelope(event({ service: "PayIn" }))), null);
  assert.equal((await service.handleCallback(envelope(event({ amount: "1.00" })))).status, 400);
  assert.equal((await service.handleCallback(envelope(event({ merchantid: "UNKNOWNORDER1234" })))).status, 404);
  assert.equal((await service.handleCallback(envelope(event({ status: "SETTLED" })))).status, 400);
  assert.equal(doc.status, "Processing");
});
