const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgentRegistrationNotices } = require("../services/agentRegistrationNotices.service");

const from = "2026-11-16T12:00:00.000Z";
const at = new Date("2026-11-16T12:30:00.000Z");
const registrationId = "000000000000000000000001";

test("verified registrations get one durable claim with only the requested client and referral fields", async () => {
  let claimed = false;
  const notices = { collection: { name: "agentregistrationnotices" }, async updateOne(filter, update, options) {
    assert.equal(filter._id, registrationId);
    assert.equal(update.$setOnInsert.claimedAt, at);
    assert.deepEqual(options, { upsert: true, writeConcern: { w: "majority", j: true } });
    if (claimed) return { upsertedCount: 0 };
    claimed = true;
    return { upsertedCount: 1 };
  } };
  const users = { aggregate(stages) {
    const filter = stages[0].$match;
    assert.equal(filter.isVerified, true);
    assert.deepEqual(filter.createdAt, { $gte: new Date(from), $lte: at });
    assert.equal(stages.some(stage => stage.$lookup?.from === "agentregistrationnotices"), true);
    assert.deepEqual(stages.at(-1).$project, { _id: 1, registeredAt: 1, fullName: 1, phone: 1, referredByIB: 1, referralCode: 1 });
    return { option: async () => [{ _id: registrationId, registeredAt: at, fullName: "Example Client", phone: "+94770000000", email: "test@example.invalid" }] };
  } };
  const service = createAgentRegistrationNotices({ users, notices, env: { BDFX_AGENT_SIGNUP_ALERTS_FROM: from }, now: () => at });
  const [item] = await service.claim();
  assert.deepEqual(Object.keys(item), ["registrationId", "claimToken", "registeredAt", "fullName", "phone", "referredByName", "referralCode"]);
  assert.equal(item.registrationId, registrationId);
  assert.equal(item.registeredAt, at.toISOString());
  assert.equal(item.fullName, "Example Client");
  assert.equal(item.phone, "+94770000000");
  assert.equal(item.referredByName, "");
  assert.equal(item.referralCode, "");
  assert.deepEqual(await service.claim(), []);
});

test("referral names follow the stable IB link and support older referral codes", async () => {
  for (const stable of [true, false]) {
    let claimed = false;
    const row = { _id: registrationId, registeredAt: at, fullName: "Example Client", phone: "+94770000000",
      referralCode: "IBOLD", ...(stable ? { referredByIB: "000000000000000000000002" } : {}) };
    const brokers = { findOne(filter) {
      assert.deepEqual(filter, stable ? { _id: row.referredByIB } : { referralCode: "IBOLD" });
      return { select(fields) {
        assert.equal(fields, "user email referralCode");
        return { maxTimeMS: () => ({ lean: async () => ({ ...(stable ? { user: "000000000000000000000003" } : {}),
          email: "referrer@example.invalid", referralCode: "IBCURRENT" }) }) };
      } };
    } };
    const users = {
      aggregate: () => ({ option: async () => [row] }),
      findOne(filter) {
        assert.deepEqual(filter, stable ? { _id: "000000000000000000000003" } : { email: "referrer@example.invalid" });
        return { select(fields) {
          assert.equal(fields, "fullName");
          return { maxTimeMS: () => ({ lean: async () => ({ fullName: "Example Agent" }) }) };
        } };
      },
    };
    const notices = { collection: { name: "agentregistrationnotices" }, updateOne: async () => {
      claimed = true;
      return { upsertedCount: 1 };
    } };
    const service = createAgentRegistrationNotices({ users, brokers, notices, env: { BDFX_AGENT_SIGNUP_ALERTS_FROM: from }, now: () => at });
    const [item] = await service.claim();
    assert.equal(claimed, true);
    assert.equal(item.referredByName, "Example Agent");
    assert.equal(item.referralCode, "IBCURRENT");
  }
});

test("a missing activation time prevents source access and receipts can only match the Agent group", async () => {
  const users = { aggregate: () => assert.fail("An unconfigured workflow claimed a signup") };
  const notices = { async updateOne(filter, update) {
    assert.equal(filter._id, registrationId);
    assert.equal(update.$set.telegramMessageId, 17);
    return { matchedCount: 1 };
  } };
  const service = createAgentRegistrationNotices({ users, notices, env: {} });
  assert.equal(await service.claim(), null);
  const receipt = { registrationId, claimToken: "bfb21470-f128-40f2-8c53-8e86c9811234", messageId: 17 };
  assert.equal(await service.receipt({ ...receipt, chatId: "-1004327283317" }), 400);
  assert.equal(await service.receipt({ ...receipt, chatId: "-1004383714191" }), 200);
});
