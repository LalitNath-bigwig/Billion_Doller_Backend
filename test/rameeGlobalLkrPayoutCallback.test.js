const test = require("node:test");
const assert = require("node:assert/strict");
const { createPayoutCallback } = require("../services/rameeGlobalLkrPayoutCallback.service");
const { createCipher } = require("../utils/rameeGlobalProtocol");

const accessKey = "0123456789abcdef0123456789abcdef";
const agentCode = "TESTAGENT0000001";
const cipher = createCipher(accessKey);

function fixture(overrides = {}) {
  const row = {
    orderid: "BDFXLKR01234",
    currency: "LKR",
    amount: 1250.50,
    status: "Processing",
    rameeGlobalLkr: { approvedAt: new Date(), payoutId: "OLKR01234" },
    ...overrides,
  };
  const matches = filter => Object.entries(filter).every(([field, expected]) => {
    const actual = field.split(".").reduce((parent, key) => parent?.[key], row);
    return expected?.$type === "date" ? actual instanceof Date : actual === expected;
  });
  let writes = 0;
  const withdrawals = {
    async updateOne(filter, changes, options) {
      if (!matches(filter)) return { modifiedCount: 0 };
      assert.deepEqual(options, { writeConcern: { w: "majority", j: true } });
      row.status = changes.$set.status;
      row.rameeGlobalLkr.providerStatus = changes.$set["rameeGlobalLkr.providerStatus"];
      writes++;
      return { modifiedCount: 1 };
    },
    findOne(filter) { return { select: () => ({ lean: async () => matches(filter) ? { status: row.status } : null }) }; },
  };
  const apply = createPayoutCallback({ withdrawals, accessKey, agentCode });
  const event = (fields = {}) => ({ agentCode, data: cipher.encrypt({
    service: "PayOut", merchantid: row.orderid, orderid: "OLKR01234", amount: "1250.50", status: "SUCCESS", ...fields,
  }) });
  return { row, apply, event, writeCount: () => writes };
}

test("only an authenticated callback for an approved processing LKR payout can complete it", async () => {
  const { row, apply, event, writeCount } = fixture();
  assert.equal(await apply({ ...event(), agentCode: "OTHER-AGENT" }), 401);
  assert.equal(await apply({ ...event(), data: "invalid ciphertext" }), 400);
  assert.equal(await apply(event({ service: "PayIn" })), 400);
  assert.equal(await apply(event({ currency: "THB" })), 400);
  assert.equal(await apply(event({ amount: "1250.51" })), 404);
  assert.equal(await apply(event({ orderid: "OLKR99999" })), 404);
  assert.equal(await apply(event({ status: "PENDING" })), 200);
  assert.equal(row.status, "Processing");
  assert.equal(await apply(event()), 200);
  assert.equal(await apply(event()), 200);
  assert.equal(row.status, "Completed");
  assert.equal(writeCount(), 1);
});

test("callbacks cannot substitute for admin approval or change a conflicting final status", async () => {
  const unapproved = fixture({ rameeGlobalLkr: { payoutId: "OLKR01234" } });
  assert.equal(await unapproved.apply(unapproved.event()), 404);
  const pending = fixture({ status: "Pending" });
  assert.equal(await pending.apply(pending.event()), 409);
  assert.equal(pending.row.status, "Pending");
  for (const status of ["FAILED", "REFUNDED"]) {
    const rejected = fixture();
    assert.equal(await rejected.apply(rejected.event({ status })), 200);
    assert.equal(rejected.row.status, "Failed");
    assert.equal(await rejected.apply(rejected.event()), 409);
    assert.equal(rejected.writeCount(), 1);
  }
});
