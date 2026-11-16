const { createCipher, readLkrMinor } = require("../../utils/rameeGlobalProtocol");


// Protocol adapter for the local LKR simulator. The caller supplies the mock transport.
// Contract: https://member.rameeglobalpay.com/docs/#encryption
const orderId = /^[a-zA-Z0-9]{4,35}$/;
const payinStatus = new Map([
  ["PENDING", "pending"], ["SUCCESS", "succeeded"], ["SETTLED", "succeeded"], ["FAILED", "failed"],
]);

function connectRameeGlobalLkrPayin({ flow, agentCode, accessKey, post }) {
  if (typeof agentCode !== "string" || agentCode.length !== 16) throw new Error("Use a 16-character test agent code.");
  const cipher = createCipher(accessKey);
  const orders = new Map();

  async function request(path, payload) {
    const result = await post(path, {
      headers: { "X-Agent-Code": agentCode, "Content-Type": "application/json" },
      body: { data: cipher.encrypt(payload) },
    });
    if (result?.success === false || !result || typeof result !== "object") {
      throw new Error("RameeGlobalPay did not confirm the request.");
    }
    return result;
  }

  function applyResult(event, order) {
    if (!order || event.merchantid !== order.id || event.orderid !== order.providerId ||
        (event.currency !== undefined && event.currency !== "LKR") ||
        readLkrMinor(event.amount) !== order.amountLkrMinor) {
      throw new Error("RameeGlobalPay result does not match the deposit.");
    }
    const status = payinStatus.get(event.status);
    if (!status) throw new Error("Unrecognized RameeGlobalPay pay-in status.");
    return flow.simulateCallback({ ...order, status });
  }

  return {
    async createCheckout(order) {
      const { id, amountLkrMinor } = order;
      if (typeof id !== "string" || !orderId.test(id) || order.currency !== "LKR" ||
          order.direction !== "deposit" || order.status !== "awaiting_payment" ||
          !Number.isSafeInteger(amountLkrMinor) || amountLkrMinor <= 0 || amountLkrMinor > 10000000) {
        throw new Error("Invalid LKR test deposit.");
      }
      const prior = orders.get(id);
      if (prior) {
        if (prior.amountLkrMinor !== amountLkrMinor) throw new Error("Deposit reference is already used for another amount.");
        return { checkoutUrl: prior.checkoutUrl, providerId: prior.providerId };
      }
      const result = await request("/order/generate", { currency: "LKR", amount: amountLkrMinor / 100, orderid: id });
      const checkout = new URL(result.url);
      if (result.success !== true || result.merchantid !== id || typeof result.orderid !== "string" ||
          !orderId.test(result.orderid) || checkout.protocol !== "https:" || checkout.username || checkout.password) {
        throw new Error("Invalid RameeGlobalPay checkout response.");
      }
      const providerId = result.orderid;
      const checkoutUrl = checkout.href;
      orders.set(id, { ...order, checkoutUrl, providerId });
      return { checkoutUrl, providerId };
    },
    applyCallback(envelope) {
      if (envelope?.agentCode !== agentCode) throw new Error("RameeGlobalPay callback agent does not match.");
      const event = cipher.decrypt(envelope.data);
      if (event?.service !== "PayIn" || event.currency !== "LKR") throw new Error("Expected an LKR pay-in callback.");
      return applyResult(event, orders.get(event.merchantid));
    },
    async refreshDeposit(id) {
      const order = orders.get(id);
      if (!order) throw new Error("Unknown RameeGlobalPay deposit.");
      const event = await request("/order/status", { orderid: order.providerId });
      return applyResult(event, order);
    },
  };
}

module.exports = { connectRameeGlobalLkrPayin, createCipher, readLkrMinor };
