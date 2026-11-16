const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgentRegistrationNotices } = require("../services/agentRegistrationNotices.service");

const from = "2026-11-16T12:00:00.000Z";
const at = new Date("2026-11-16T12:30:00.000Z");
const registrationId = "000000000000000000000001";

test("verified registrations after the configured start get one durable claim without contact data", async () => {
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
    return { option: async () => [{ _id: registrationId, registeredAt: at, email: "test@example.invalid" }] };
  } };
  const service = createAgentRegistrationNotices({ users, notices, env: { BDFX_AGENT_SIGNUP_ALERTS_FROM: from }, now: () => at });
  const [item] = await service.claim();
  assert.deepEqual(Object.keys(item), ["registrationId", "claimToken", "registeredAt"]);
  assert.equal(item.registrationId, registrationId);
  assert.equal(item.registeredAt, at.toISOString());
  assert.deepEqual(await service.claim(), []);
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
