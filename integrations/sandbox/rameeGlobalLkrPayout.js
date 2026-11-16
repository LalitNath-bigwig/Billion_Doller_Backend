const { createCipher, readLkrMinor } = require("../../utils/rameeGlobalProtocol");

const providerReference = /^[a-zA-Z0-9]{1,45}$/;
const payoutStatus = new Map([
  ["PENDING", "pending"],
  ["SUCCESS", "succeeded"],
  ["FAILED", "failed"],
  ["REFUNDED", "failed"],
]);

// Mock transport only. The submission test substitutes LKR in the published
// THB example. Ramee has not confirmed that LKR uses these beneficiary fields.
function connectRameeGlobalLkrPayout({ flow, agentCode, accessKey, post }) {
  if (typeof agentCode !== "string" || agentCode.length !== 16) throw new Error("Use a 16-character test agent code.");
  const cipher = createCipher(accessKey);
  const providerIds = new Map();
  const merchantIds = new Map();
  const submitted = new Set();

  async function request(path, payload) {
    const result = await post(path, {
      headers: { "X-Agent-Code": agentCode, "Content-Type": "application/json" },
      body: { data: cipher.encrypt(payload) },
    });
    if (result?.success !== true) throw new Error("RameeGlobalPay did not confirm the payout request.");
    return result;
  }

  async function listMethods() {
    const result = await request("/payout/methods", { currency: "LKR" });
    if (!Array.isArray(result.methods)) throw new Error("Invalid RameeGlobalPay methods response.");
    return result.methods;
  }

  function approvedWithdrawal(id) {
    const order = flow.getOrder(id);
    if (order?.direction !== "withdrawal" || order.currency !== "LKR" || order.status !== "processing") {
      throw new Error("Approve the LKR test withdrawal first.");
    }
    return order;
  }

  function bindProvider(id, providerId) {
    if (typeof providerId !== "string" || !providerReference.test(providerId)) {
      throw new Error("Invalid RameeGlobalPay provider reference.");
    }
    if (providerIds.get(id) === providerId) return providerId;
    if (providerIds.has(id) || merchantIds.has(providerId)) throw new Error("Conflicting RameeGlobalPay payout references.");
    approvedWithdrawal(id);
    providerIds.set(id, providerId);
    merchantIds.set(providerId, id);
    return providerId;
  }

  function recordAcceptance(id, result) {
    if (result?.success !== true || !["INITIATED", "PENDING"].includes(result.status) || result.merchantid !== id) {
      throw new Error("Invalid RameeGlobalPay payout acceptance.");
    }
    return bindProvider(id, result.orderid);
  }

  function requireUnsubmitted(id) {
    if (submitted.has(id) || providerIds.has(id)) {
      throw new Error("Check the existing payout status before taking further action.");
    }
  }

  function applyStatus(merchantId, providerId, rawStatus) {
    const order = flow.getOrder(merchantId);
    if (!order || !providerIds.has(merchantId) || providerIds.get(merchantId) !== providerId) {
      throw new Error("RameeGlobalPay result does not match the withdrawal references.");
    }
    const status = payoutStatus.get(rawStatus);
    if (!status) throw new Error("Unrecognized RameeGlobalPay payout status.");
    return flow.simulateCallback({ ...order, status });
  }

  return {
    listMethods,
    recordAcceptance,
    async submitWithdrawal(id, { code, account } = {}) {
      requireUnsubmitted(id);
      const order = approvedWithdrawal(id);
      if (typeof code !== "string" || !code.trim() || typeof account !== "string" || !account.trim()) {
        throw new Error("Provide a test bank code and account number.");
      }
      const methods = await listMethods();
      if (!methods.some(method => method?.code === code)) {
        throw new Error("The test bank code is not available for LKR.");
      }
      // Another request may have submitted while this request fetched methods.
      requireUnsubmitted(id);
      submitted.add(id);
      try {
        const response = await request("/payout/request", {
          currency: "LKR", amount: order.amountLkrMinor / 100, orderid: id, orderDetail: { code, account },
        });
        return recordAcceptance(id, response);
      } catch {
        throw new Error("Payout submission is unconfirmed. Check the original reference before taking further action.");
      }
    },
    applyCallback(envelope) {
      if (envelope?.agentCode !== agentCode) throw new Error("RameeGlobalPay callback agent does not match.");
      const event = cipher.decrypt(envelope.data);
      if (event?.service !== "PayOut" || (event.currency !== undefined && event.currency !== "LKR")) {
        throw new Error("Expected an LKR payout callback.");
      }
      const order = flow.getOrder(event.merchantid);
      if (!order || readLkrMinor(event.amount, 14) !== order.amountLkrMinor) {
        throw new Error("RameeGlobalPay callback does not match the withdrawal amount.");
      }
      return applyStatus(event.merchantid, event.orderid, event.status);
    },
    async refreshWithdrawal(id) {
      if (!providerIds.has(id) && !submitted.has(id)) throw new Error("Unknown RameeGlobalPay payout.");
      const event = await request("/payout/status", { orderid: id });
      if (event.orderId !== id) throw new Error("RameeGlobalPay status does not match the requested withdrawal.");
      if (!providerIds.has(id) && payoutStatus.has(event.status)) bindProvider(id, event.systemId);
      return applyStatus(id, event.systemId, event.status);
    },
  };
}

module.exports = { connectRameeGlobalLkrPayout };
