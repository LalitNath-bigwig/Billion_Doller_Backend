const { createCipher } = require("./rameeGlobalProtocol");

const reference = /^[a-zA-Z0-9]{4,35}$/;

function createLkrClient({ baseUrl, agentCode, accessKey, fetchImpl = fetch, currency = "LKR", maxMinor = 10000000 }) {
  if (typeof baseUrl !== "string" || !URL.canParse(baseUrl)) {
    throw new Error("Set the HTTPS API base URL supplied by RameeGlobalPay.");
  }
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password ||
      base.search || base.hash || !/\/v1\/?$/.test(base.pathname)) {
    throw new Error("Use the provider's HTTPS API base ending in /v1, without credentials or query parameters.");
  }
  if (typeof agentCode !== "string" || !/^[\x21-\x7e]{16}$/.test(agentCode)) {
    throw new Error("Use the 16-character RameeGlobalPay agent code.");
  }
  const cipher = createCipher(accessKey);

  async function request(path, payload) {
    const endpoint = new URL(base);
    endpoint.pathname = base.pathname.replace(/\/$/, "") + path;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "X-Agent-Code": agentCode, "Content-Type": "application/json" },
      body: JSON.stringify({ data: cipher.encrypt(payload) }),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    }).catch(() => {
      throw new Error("Could not reach RameeGlobalPay.");
    });
    if (!response.ok) throw new Error(`RameeGlobalPay request returned HTTP ${response.status}.`);
    let result;
    try { result = await response.json(); } catch {
      throw new Error("RameeGlobalPay did not return a valid JSON response.");
    }
    if (!result || typeof result !== "object" || Array.isArray(result) || result.success === false) {
      const detail = typeof result?.message === "string" ? ` Gateway said: ${result.message.slice(0, 200)}` : "";
      throw new Error(`RameeGlobalPay did not confirm the request.${detail}`);
    }
    // The merchant API can wrap a response in the same authenticated
    // envelope used by callbacks. Some endpoints also return plain JSON.
    if (typeof result.data === "string") {
      if (result.success !== true) throw new Error("Invalid RameeGlobalPay response envelope.");
      try { result = cipher.decrypt(result.data); } catch {
        throw new Error("Invalid RameeGlobalPay response envelope.");
      }
      if (!result || typeof result !== "object" || Array.isArray(result) || result.success === false) {
        throw new Error("RameeGlobalPay did not confirm the request.");
      }
    }
    return result;
  }

  return {
    async createCheckout({ orderid, amountLkrMinor }) {
      if (typeof orderid !== "string" || !reference.test(orderid) ||
          !Number.isSafeInteger(amountLkrMinor) || amountLkrMinor < 1 || amountLkrMinor > maxMinor) {
        throw new Error("Invalid RameeGlobalPay deposit.");
      }
      const result = await request("/order/generate", { orderid, currency, amount: amountLkrMinor / 100 });
      if (result.success !== true || result.merchantid !== orderid ||
          typeof result.orderid !== "string" || !reference.test(result.orderid) ||
          typeof result.url !== "string" || !URL.canParse(result.url)) {
        throw new Error("Invalid RameeGlobalPay checkout response.");
      }
      const url = new URL(result.url);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid RameeGlobalPay checkout URL.");
      return { providerOrderId: result.orderid, url: url.href };
    },
    depositStatus(orderid) {
      if (typeof orderid !== "string" || !reference.test(orderid)) throw new Error("Invalid RameeGlobalPay deposit reference.");
      return request("/order/status", { orderid });
    },
    decodeDepositCallback(envelope) {
      if (envelope?.agentCode !== agentCode) throw new Error("Invalid RameeGlobalPay callback agent.");
      const event = cipher.decrypt(envelope.data);
      if (event?.service !== "PayIn" || event.currency !== currency ||
          typeof event.merchantid !== "string" || !reference.test(event.merchantid)) {
        throw new Error(`Invalid ${currency} deposit callback.`);
      }
      return event;
    },
    async listPayoutMethods() {
      const result = await request("/payout/methods", { currency });
      if (result.success !== true || !Array.isArray(result.methods)) throw new Error("Invalid RameeGlobalPay methods response.");
      return result.methods.map(method => {
        if (typeof method?.code !== "string" || !method.code.trim()) throw new Error("RameeGlobalPay returned a method without a valid code.");
        return { code: method.code.trim(), description: typeof method.description === "string" ? method.description : "" };
      });
    },
  };
}

module.exports = { createLkrClient, reference };

//test commit