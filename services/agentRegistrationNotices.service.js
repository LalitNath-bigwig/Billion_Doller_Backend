const { randomUUID } = require("node:crypto");
const User = require("../models/User");
const IB = require("../models/Broker.model");
const Notice = require("../models/AgentRegistrationNotice");

const AGENT_CHAT_ID = "-1004383714191";
const DURABLE = { writeConcern: { w: "majority", j: true } };

function createAgentRegistrationNotices({ users = User, brokers = IB, notices = Notice, env = process.env, now = () => new Date() } = {}) {
  async function claim() {
    const after = new Date(env.BDFX_AGENT_SIGNUP_ALERTS_FROM || "");
    const at = now();
    if (!Number.isFinite(+after) || after.toISOString() !== env.BDFX_AGENT_SIGNUP_ALERTS_FROM) return null;
    const candidates = await users.aggregate([
      { $match: { isVerified: true, portalBlocked: { $ne: true }, createdAt: { $gte: after, $lte: at } } },
      { $project: { _id: 1, createdAt: 1, fullName: 1, phone: 1, referredByIB: 1, referralCode: 1, registeredAt: {
        $max: ["$createdAt", "$emailVerifiedAt", "$phoneVerifiedAt", "$registrationOwnerApproval.approvedAt"],
      } } },
      { $match: { registeredAt: { $gte: after, $lte: at } } },
      { $sort: { registeredAt: 1, _id: 1 } },
      { $lookup: { from: notices.collection.name, localField: "_id", foreignField: "_id", as: "delivery" } },
      { $match: { "delivery.0": { $exists: false } } },
      { $limit: 15 },
      { $project: { _id: 1, registeredAt: 1, fullName: 1, phone: 1, referredByIB: 1, referralCode: 1 } },
    ]).option({ maxTimeMS: 10000 });

    for (const row of candidates) {
      let referredByName = "";
      let referralCode = row.referralCode || "";
      if (row.referredByIB || referralCode) {
        const broker = await brokers.findOne(row.referredByIB ? { _id: row.referredByIB } : { referralCode })
          .select("user email referralCode").maxTimeMS(5000).lean();
        if (broker) {
          referralCode = broker.referralCode || referralCode;
          const referrer = await users.findOne(broker.user ? { _id: broker.user } : { email: broker.email })
            .select("fullName").maxTimeMS(5000).lean();
          referredByName = referrer?.fullName || "";
        }
      }
      const filter = { _id: row._id };
      const claimToken = randomUUID();
      try {
        const result = await notices.updateOne(filter, { $setOnInsert: { claimToken, claimedAt: at } }, { upsert: true, ...DURABLE });
        if (result.upsertedCount === 1) return [{ registrationId: String(row._id), claimToken,
          registeredAt: row.registeredAt.toISOString(), fullName: row.fullName || "", phone: row.phone || "", referredByName, referralCode }];
      } catch (error) {
        if (error?.code !== 11000) throw error;
      }
    }
    return [];
  }

  async function receipt({ registrationId, claimToken, chatId, messageId } = {}) {
    if (typeof registrationId !== "string" || !/^[a-f0-9]{24}$/.test(registrationId) ||
        typeof claimToken !== "string" || !/^[a-f0-9-]{36}$/.test(claimToken) ||
        chatId !== AGENT_CHAT_ID || !Number.isSafeInteger(messageId) || messageId <= 0) return 400;
    const result = await notices.updateOne({
      _id: registrationId, claimToken,
      $or: [{ telegramMessageId: { $exists: false } }, { telegramMessageId: messageId }],
    }, { $set: { telegramMessageId: messageId } }, DURABLE);
    return result.matchedCount === 1 ? 200 : 409;
  }

  return { claim, receipt };
}

module.exports = { createAgentRegistrationNotices };
