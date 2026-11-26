const test = require("node:test");
const assert = require("node:assert/strict");
const { createController } = require("../controllers/ownerTradingReviewController");

const id = "111111111111111111111111";
const evidenceId = "222222222222222222222222";
const updatedAt = new Date("2026-11-14T12:00:00.000Z");
const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } });

function fixture() {
  const user = { _id: id, updatedAt, isVerified: true, isKycVerified: false, phone: "+919876543210", nationality: "India", country: "India" };
  const records = { uploaded: [], removed: [], reviews: [], evidence: [], failUpload: false, duplicate: false };
  const query = value => ({ select() { return this; }, async session() { return value; }, then(resolve) { return Promise.resolve(value).then(resolve); } });
  const controller = createController({
    users: { findById: () => query(user), exists: () => query(records.duplicate), async updateOne(_filter, { $set }) { Object.assign(user, $set); return { modifiedCount: 1 }; } },
    reviews: { async create([entry]) { records.reviews.push(entry); }, async findOne(filter) { return records.reviews.find(entry => entry.userId === filter.userId && entry.reviewId === filter.reviewId); } },
    evidence: { async create([entry]) { const row = { _id: evidenceId, ...entry }; records.evidence.push(row); return [row]; }, async findOne(filter) { return records.evidence.find(entry => entry.userId === filter.userId && entry._id === filter._id); } },
    transaction: async work => work({}), ensure: async () => {}, providerEnabled: () => false,
    async store(buffer, format, assetId) { records.uploaded.push(assetId); if (records.failUpload) throw Error("Failed"); return { id: assetId, format }; },
    async remove(assetId) { records.removed.push(assetId); }, signedLink: asset => `private:${asset.id}`,
  });
  const req = { params: { id }, principal: { isAdmin: true, adminRole: "owner", id: "owner", email: "owner@example.invalid" },
    files: { identity: [{ buffer: Buffer.from("%PDF-1.7 identity") }], address: [{ buffer: Buffer.from("%PDF-1.7 address") }] },
    body: { expectedUpdatedAt: updatedAt.toISOString(), documentCountry: "IN", reason: "Checked original identity and proof of address", reviewedEvidence: "true" } };
  return { controller, req, user, records };
}

test("only owner can record or retrieve private evidence and approval leaves OTP data intact", async () => {
  const { controller, req, user, records } = fixture();
  const manager = { ...req, principal: { isAdmin: true, adminRole: "manager" } };
  for (const action of ["approve", "getEvidence"]) {
    const res = response(); await controller[action](manager, res); assert.equal(res.code, 403);
  }
  const approved = response(); await controller.approve(req, approved);
  assert.equal(approved.data.approved, true);
  assert.equal(records.uploaded.length, 2);
  assert.equal(records.reviews[0].evidenceReference, evidenceId);
  assert.equal(user.isKycVerified, true);
  assert.equal(user.phoneVerifiedAt, undefined);
  assert.equal(records.removed.length, 0);
  const evidence = response(); await controller.getEvidence(req, evidence);
  assert.equal(evidence.data.identity, `private:${records.uploaded[0]}`);
  assert.equal(evidence.data.address, `private:${records.uploaded[1]}`);
});

test("missing evidence, stale reviews and duplicate mobile numbers cannot approve trading", async () => {
  const { controller, req, user, records } = fixture();
  const missing = response(); await controller.approve({ ...req, files: {} }, missing);
  assert.equal(missing.code, 400);
  const stale = response(); await controller.approve({ ...req, body: { ...req.body, expectedUpdatedAt: "" } }, stale);
  assert.equal(stale.code, 409);
  assert.equal(records.uploaded.length, 0);
  records.duplicate = true;
  const duplicate = response(); await controller.approve(req, duplicate);
  assert.equal(duplicate.code, 409);
  assert.equal(user.isKycVerified, false);
  assert.deepEqual(records.removed, records.uploaded);
  assert.equal(records.reviews.length, 0);
});

test("a delegated manager can approve with a recorded identity but cannot retrieve archived documents", async () => {
  const { controller, req, records } = fixture();
  req.principal = { isAdmin: true, adminRole: "manager", permissions: ["trading_approval"], id: "manager", email: "reviewer@example.invalid" };
  const approved = response();
  await controller.approve(req, approved);
  assert.equal(approved.data.approved, true);
  assert.equal(req.auditEvent, "kyc:manager-trading-approved");
  assert.equal(records.reviews[0].reviewerId, req.principal.id);
  assert.equal(records.reviews[0].reviewerEmail, req.principal.email);
  const archived = response();
  await controller.getEvidence(req, archived);
  assert.equal(archived.code, 403);
});

test("client lookup requires explicit approval permission and an exact registered email", async () => {
  const client = { _id: id, fullName: "Sample Client", email: "sample@example.invalid" };
  let matches = [client];
  const controller = createController({ providerEnabled: () => false, users: { find({ email }) {
    assert.ok(email.test(client.email));
    assert.equal(email.test("other" + client.email), false);
    return { select(fields) {
      assert.equal(fields, "_id fullName email isVerified isKycVerified updatedAt portalBlocked portalAccessStatus");
      return { limit(size) { assert.equal(size, 2); return { lean: async () => matches }; } };
    } };
  } } });
  const req = { principal: { isAdmin: true, adminRole: "manager", permissions: ["crm"] }, query: { email: client.email } };
  const check = async () => { const res = response(); await controller.findClient(req, res, err => { throw err; }); return res; };
  assert.equal((await check()).code, 403);
  req.principal.permissions.push("trading_approval");
  assert.deepEqual((await check()).data, client);
  matches = [client, client];
  assert.equal((await check()).code, 409);
});
