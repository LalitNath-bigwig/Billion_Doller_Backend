const { createCipher, readLkrMinor } = require("../utils/rameeGlobalProtocol");

const reference = /^[A-Za-z0-9]{1,45}$/;
const finalStatuses = new Map([["SUCCESS", "Completed"], ["FAILED", "Failed"], ["REFUNDED", "Failed"]]);
const durable = { writeConcern: { w: "majority", j: true } };

function createPayoutCallback({ withdrawals, agentCode, accessKey }) {
  if (typeof agentCode !== "string" || !/^[\x21-\x7e]{16}$/.test(agentCode)) throw new Error("RameeGlobalPay is not configured.");
  const cipher = createCipher(accessKey);

  return async function settleCallback(envelope) {
    let event;
    let amountMinor;
    try {
      if (envelope?.agentCode !== agentCode) return 401;
      event = cipher.decrypt(envelope.data);
      if (event?.service !== "PayOut" || (event.currency !== undefined && event.currency !== "LKR") ||
          typeof event.merchantid !== "string" || !reference.test(event.merchantid) ||
          typeof event.orderid !== "string" || !reference.test(event.orderid) ||
          (event.status !== "PENDING" && !finalStatuses.has(event.status))) return 400;
      amountMinor = readLkrMinor(event.amount, 14);
      if (amountMinor <= 0) return 400;
    } catch { return 400; }

    // PayOut callbacks can omit currency. The persisted, approved LKR order
    // establishes it and binds both references to this exact amount.
    const match = {
      orderid: event.merchantid,
      currency: "LKR",
      amount: amountMinor / 100,
      "rameeGlobalLkr.approvedAt": { $type: "date" },
      "rameeGlobalLkr.payoutId": event.orderid,
    };
    const target = finalStatuses.get(event.status);
    if (target) {
      const update = await withdrawals.updateOne({ ...match, status: "Processing" }, {
        $set: { status: target, "rameeGlobalLkr.providerStatus": event.status },
      }, durable);
      if (update.modifiedCount === 1) return 200;
    }
    const previous = await withdrawals.findOne(match).select("status").lean();
    if (!previous) return 404;
    if (target ? previous.status === target : ["Processing", "Completed", "Failed"].includes(previous.status)) return 200;
    return 409;
  };
}

module.exports = { createPayoutCallback };
