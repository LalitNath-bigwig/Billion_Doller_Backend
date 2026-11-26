const { randomUUID } = require("node:crypto");
const User = require("../models/User");
const KycReview = require("../models/KycReview");
const OwnerKycEvidence = require("../models/OwnerKycEvidence");
const cloudinary = require("../utils/cloudinary");
const { isUae } = require("../utils/veriffPolicy");
const { phonePattern, emailPattern } = require("../utils/registrationIdentity");
const { canApproveTrading } = require("../services/adminPolicy");
const veriff = require("../services/veriff.service");

const regions = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
const objectId = /^[a-f\d]{24}$/i;
const versionPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const assetFormat = /^(jpg|jpeg|png|pdf)$/;

function fileFormat(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) return "pdf";
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "jpg";
  return null;
}

const assetFolder = "bdfx-owner-kyc";
const assetOptions = { type: "authenticated", resource_type: "image" };
function storeEvidence(buffer, format, id) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ ...assetOptions, folder: assetFolder,
      public_id: id.split("/").at(-1), allowed_formats: [format, ...(format === "jpg" ? ["jpeg"] : [])], timeout: 60000,
    }, (error, result) => {
      if (error || result?.public_id !== id || !assetFormat.test(result.format)) return reject(new Error("Evidence upload failed."));
      resolve({ id, format: result.format });
    });
    stream.once("error", reject);
    stream.end(buffer);
  });
}

const removeEvidence = id => cloudinary.uploader.destroy(id, assetOptions);
const evidenceLink = asset => cloudinary.utils.private_download_url(asset.id, asset.format, {
  ...assetOptions, expires_at: Math.floor(Date.now() / 1000) + 300,
});
async function ensureCollections() {
  for (const model of [KycReview, OwnerKycEvidence]) {
    try { await model.createCollection(); } catch (error) { if (error.code !== 48) throw error; }
  }
}

function createController({ users = User, reviews = KycReview, evidence = OwnerKycEvidence,
  transaction = work => User.db.transaction(work, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }),
  ensure = ensureCollections, store = storeEvidence, remove = removeEvidence, signedLink = evidenceLink,
  providerEnabled = veriff.isEnabled, now = () => new Date(),
} = {}) {
  const canReview = req => req.principal?.isAdmin && req.principal.adminRole === "owner";
  const sendError = (res, httpStatus, message) => res.status(httpStatus).json({ message });
  function checkAccount(user, version) {
    if (!user) return [404, "Client not found."];
    if ((user.updatedAt?.toISOString() ?? "") !== version) return [409, "The client record changed. Close and reopen it before reviewing."];
    if (user.isKycVerified) return [409, "Trading verification is already approved."];
    if (!user.isVerified || user.portalBlocked || user.portalAccessStatus === "rejected") return [409, "The client needs an active, verified registration before trading verification."];
    if ([user.nationality, user.residenceCountry, user.country].some(isUae) || /\bUAE\b/i.test(user.veriff?.message || "") ||
        !String(user.residenceCountry || user.country || "").trim()) {
      return [409, "Confirm an eligible country of residence before approving this client."];
    }
    if (!phonePattern(user.phone)) return [409, "The client must have a valid registered mobile number."];
    return null;
  }

  return {
    async findClient(req, res, next) {
      if (!canApproveTrading(req.principal)) return sendError(res, 403, "Trading approval permission is required.");
      if (providerEnabled()) return sendError(res, 409, "Use the current identity review flow.");
      const email = emailPattern(req.query.email);
      if (!email) return sendError(res, 400, "Enter the client's registered email.");
      try {
        const matches = await users.find({ email })
          .select("_id fullName email isVerified isKycVerified updatedAt portalBlocked portalAccessStatus").limit(2).lean();
        if (!matches.length) return sendError(res, 404, "Client not found.");
        if (matches.length > 1) return sendError(res, 409, "Multiple client records match. Ask the owner to check the account.");
        return res.json(matches[0]);
      } catch (error) { return next(error); }
    },
    async approve(req, res) {
      if (!canApproveTrading(req.principal)) return sendError(res, 403, "Trading approval permission is required.");
      if (providerEnabled()) return sendError(res, 409, "Use the current identity review flow.");
      const { id } = req.params;
      const { expectedUpdatedAt: version, documentCountry, reason, caseReference = "", reviewedEvidence } = req.body || {};
      const files = [req.files?.identity?.[0], req.files?.address?.[0]];
      const formats = files.map(file => fileFormat(file?.buffer));
      if (!objectId.test(id || "") || typeof version !== "string" || (!versionPattern.test(version) && version !== "") ||
          typeof documentCountry !== "string" || !/^[A-Z]{2}$/.test(documentCountry) || documentCountry === "ZZ" ||
          !regions.of(documentCountry) || isUae(documentCountry) || reviewedEvidence !== "true" ||
          typeof reason !== "string" || reason.trim().length < 20 || reason.length > 1000 ||
          typeof caseReference !== "string" || (caseReference && !/^[A-Za-z0-9][A-Za-z0-9._/-]{2,79}$/.test(caseReference)) ||
          formats.includes(null)) {
        return sendError(res, 400, "Upload identity and proof of address files, select the issuing country, and record what you verified.");
      }
      const ids = files.map(() => `${assetFolder}/${randomUUID()}`);
      let attemptedUpload = false;
      let committed = false;
      try {
        const first = checkAccount(await users.findById(id), version);
        if (first) return sendError(res, ...first);
        await ensure();
        attemptedUpload = true;
        const uploads = await Promise.allSettled(files.map((file, i) => store(file.buffer, formats[i], ids[i])));
        if (uploads.some(upload => upload.status === "rejected")) throw new Error("Evidence upload failed.");
        const [identity, address] = uploads.map(upload => upload.value);
        const result = await transaction(async session => {
          const user = await users.findById(id).session(session);
          const issue = checkAccount(user, version);
          if (issue) return { issue };
          if (await users.exists({ _id: { $ne: id }, phone: phonePattern(user.phone) }).session(session)) {
            return { issue: [409, "The mobile number is also registered to another client."] };
          }
          const reviewedAt = now();
          const decision = { reviewId: randomUUID(), source: "owner_documents", approved: true,
            reviewerId: req.principal.id, reviewedAt };
          const [record] = await evidence.create([{ userId: id, identity, address, caseReference }], { session });
          await reviews.create([{ ...decision, userId: id, reviewerEmail: req.principal.email,
            reason: reason.trim(), documentCountry, evidenceReference: String(record._id) }], { session });
          const updated = await users.updateOne({ _id: id }, { $set: { isKycVerified: true, kycManualReview: decision } }, { session, runValidators: true });
          if (updated.modifiedCount !== 1) throw new Error("Review was not applied.");
          return { reviewedAt };
        });
        if (result.issue) return sendError(res, ...result.issue);
        committed = true;
        req.auditEvent = req.principal.adminRole === "owner" ? "kyc:owner-trading-approved" : "kyc:manager-trading-approved";
        req.auditTargetId = id;
        return res.json({ approved: true, reviewedAt: result.reviewedAt, message: "Trading verification approved." });
      } catch (error) {
        if (error.hasErrorLabel?.("UnknownTransactionCommitResult")) attemptedUpload = false;
        return sendError(res, 503, "Could not confirm the trading review. Refresh the client record before retrying.");
      } finally {
        if (attemptedUpload && !committed) {
          const results = await Promise.allSettled(ids.map(id => remove(id)));
          if (results.some(result => result.status === "rejected")) console.error("Owner trading evidence cleanup unavailable.");
        }
      }
    },
    async getEvidence(req, res) {
      if (!canReview(req)) return sendError(res, 403, "Only an owner can open trading verification evidence.");
      const { id } = req.params;
      if (!objectId.test(id || "")) return sendError(res, 404, "Client not found.");
      try {
        const user = await users.findById(id).select("+kycManualReview");
        const reviewId = user?.kycManualReview?.reviewId;
        if (!reviewId || user.kycManualReview.source !== "owner_documents") return sendError(res, 404, "No owner-uploaded evidence is available.");
        const review = await reviews.findOne({ userId: id, reviewId, approved: true });
        if (!objectId.test(review?.evidenceReference || "")) return sendError(res, 404, "No owner-uploaded evidence is available.");
        const record = await evidence.findOne({ _id: review.evidenceReference, userId: id });
        if (!record) return sendError(res, 404, "No owner-uploaded evidence is available.");
        return res.json({ identity: signedLink(record.identity), address: signedLink(record.address), reviewedAt: review.reviewedAt, caseReference: record.caseReference });
      } catch { return sendError(res, 503, "Unable to open the evidence. Please try again."); }
    },
  };
}

module.exports = { createController, ...createController() };
