const test = require("node:test");
const assert = require("node:assert/strict");
const { classify, amountFor, receipt, releaseRejected, prepare } = require("../services/paymentAlerts.service");
const at = new Date("2026-01-04T10:20:00Z");
test("every new withdrawal is announced even if completed before the first read", () => {
  for (const status of ["Pending", "Processing", "Completed", "Rejected", "Failed"])
    assert.equal(classify("withdrawal", { status }, null, at), "withdrawal_new");
});
test("only a still-pending request can repeat, ten minutes from confirmed delivery", () => {
  const previous = new Date(+at - 600000);
  assert.equal(classify("withdrawal", { status: "Pending" }, previous, at), "withdrawal_reminder");
  assert.equal(classify("withdrawal", { status: "Pending" }, new Date(+previous + 1), at), "defer");
  for (const status of ["Processing", "Completed", "Rejected", "Failed"])
    assert.equal(classify("withdrawal", { status }, previous, at), "closed");
});
test("drop detection excludes successful, credited, unknown and in-flight deposits", () => {
  for (const status of ["PENDING", "PARTIALLY_PAID", "SUCCESS"]) assert.equal(classify("deposit", { status }, null, at), "closed");
  const failed = { status: "FAILED" };
  assert.equal(classify("deposit", failed, null, at), "deposit_drop");
  assert.equal(classify("deposit", { ...failed, creditedAmount: 0.01 }, null, at), "closed");
  assert.equal(classify("deposit", { ...failed, settlementAttempt: { state: "review" } }, null, at), "defer");
  assert.equal(classify("deposit", { status: "PENDING", provider: "RAMEE", rameeDropAt: at }, null, at), "deposit_drop");
});
test("amounts use the currency actually recorded with the request", () => {
  assert.deepEqual(amountFor("deposit", { provider: "RAMEE_GLOBAL_LKR", rameeGlobalLkr: { amountLkrMinor: 123456 } }), [1234.56, "LKR"]);
  assert.deepEqual(amountFor("withdrawal", { amount: 23, currency: "CRYPTO", cryptoSymbol: "USDT" }), [23, "USDT"]);
  assert.deepEqual(amountFor("deposit", { amount: 99, provider: "unknown" }), [null, null]);
});
test("invalid references and ambiguous send failures cannot release a claim", async () => {
  assert.equal(await prepare("wrong"), null);
  assert.equal(await receipt({ key: "wrong" }), 400);
  assert.equal(await releaseRejected({ key: "deposit:" + "1".repeat(24), claim: "1".repeat(36), errorCode: 502 }), 400);
});
