const test = require("node:test");
const assert = require("node:assert/strict");
const { createLkrSandbox } = require("../integrations/sandbox/lkrPaymentFlow");

const makeSandbox = (openingUsdCents = 0) => createLkrSandbox({ lkrMinorPerUsd: 30000, openingUsdCents });
const callback = (flow, order, status, overrides = {}) => flow.simulateCallback({ ...order, status, ...overrides });

test("deposit credits once on matching success, including when a callback is retried", () => {
  const flow = makeSandbox();
  const deposit = flow.createDeposit(3000000);
  assert.equal(callback(flow, deposit, "pending").status, "awaiting_payment");
  assert.equal(flow.balance().availableUsdCents, 0n);
  assert.equal(callback(flow, deposit, "succeeded").status, "succeeded");
  assert.equal(callback(flow, deposit, "succeeded").status, "succeeded");
  assert.equal(callback(flow, deposit, "pending").status, "succeeded");
  assert.throws(() => callback(flow, deposit, "failed"), /Conflicting final status/);
  assert.equal(flow.balance().availableUsdCents, 10000n);
});

test("a callback for the wrong amount, currency or operation has no balance effect", () => {
  const flow = makeSandbox();
  const deposit = flow.createDeposit(3000000);
  for (const mismatch of [{ amountLkrMinor: 1 }, { currency: "INR" }, { direction: "withdrawal" }, { id: "other" }]) {
    assert.throws(() => callback(flow, deposit, "succeeded", mismatch), /does not match/);
  }
  assert.equal(callback(flow, deposit, "failed").status, "failed");
  assert.equal(flow.balance().availableUsdCents, 0n);
});

test("pending withdrawal holds funds and confirmed payout consumes the reserve once", () => {
  const flow = makeSandbox(10000);
  const payout = flow.requestWithdrawal(600000);
  assert.throws(() => callback(flow, payout, "succeeded"), /Approve the withdrawal/);
  assert.throws(() => flow.requestWithdrawal(3000000), /Insufficient/);
  flow.resolveWithdrawal(payout.id, "approve");
  assert.equal(callback(flow, payout, "pending").status, "processing");
  assert.deepEqual(flow.balance(), { availableUsdCents: 8000n, reservedUsdCents: 2000n });
  callback(flow, payout, "succeeded");
  callback(flow, payout, "succeeded");
  assert.deepEqual(flow.balance(), { availableUsdCents: 8000n, reservedUsdCents: 0n });
});

test("rejected or confirmed failed payouts restore the reserve without double refund", () => {
  const flow = makeSandbox(10000);
  const rejected = flow.requestWithdrawal(600000);
  assert.equal(flow.resolveWithdrawal(rejected.id, "reject").status, "rejected");
  const failed = flow.requestWithdrawal(600000);
  flow.resolveWithdrawal(failed.id, "approve");
  callback(flow, failed, "failed");
  callback(flow, failed, "failed");
  assert.throws(() => callback(flow, failed, "succeeded"), /Conflicting final status/);
  assert.deepEqual(flow.balance(), { availableUsdCents: 10000n, reservedUsdCents: 0n });
});

test("conversion locks integer amounts at the fictional rate", () => {
  const flow = makeSandbox(100);
  assert.equal(flow.createDeposit(301).usdCents, 1n);
  assert.equal(flow.requestWithdrawal(301).usdCents, 2n);
  assert.throws(() => flow.createDeposit(1), /below one USD cent/);
  assert.throws(() => flow.createDeposit(1.2), /positive LKR amount/);
});
