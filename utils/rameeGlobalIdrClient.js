// IDR pay-ins through RameeGlobalPay's own SDK (utils/raamiClient.js, copied unchanged).
// Reads RAMEE_GLOBAL_IDR_AGENT_CODE and RAMEE_GLOBAL_IDR_ACCESS_KEY.
// The SDK's base URL is fixed: https://rapis.rameeglobalpay.com/v1
const { RaamiClient } = require("./raamiClient");

const reference = /^[a-zA-Z0-9]{4,35}$/; // docs: orderid is letters and digits, 4-35 characters

function config() {
  const agentCode = process.env.RAMEE_GLOBAL_IDR_AGENT_CODE || "";
  const accessKey = process.env.RAMEE_GLOBAL_IDR_ACCESS_KEY || "";
  if (agentCode.length !== 16) throw new Error("Set RAMEE_GLOBAL_IDR_AGENT_CODE to the 16-character agent code.");
  if (Buffer.byteLength(accessKey) !== 32) throw new Error("Set RAMEE_GLOBAL_IDR_ACCESS_KEY to the 32-character access key.");
  return { agentCode, accessKey };
}

// A RaamiClient whose encrypt/decrypt also print what goes in and comes out.
function sdk() {
  const { agentCode, accessKey } = config();
  const client = new RaamiClient("production", agentCode, accessKey);
  const encrypt = client.encrypt.bind(client);
  const decrypt = client.decrypt.bind(client);
  client.encrypt = obj => {
    console.log("[RameeGlobal IDR] encrypt input:", JSON.stringify(obj));
    const data = encrypt(obj);
    console.log("[RameeGlobal IDR] encrypt output (data):", data);
    return data;
  };
  client.decrypt = text => {
    console.log("[RameeGlobal IDR] decrypt input (data):", text);
    try {
      const out = decrypt(text);
      console.log("[RameeGlobal IDR] decrypt output:", JSON.stringify(out));
      return out;
    } catch (error) {
      console.log(`[RameeGlobal IDR] decrypt failed: ${error.message}`);
      throw error;
    }
  };
  return client;
}

// SDK result is { success, httpStatus, message, data }.
function unwrap(path, result) {
  console.log(`[RameeGlobal IDR] ${path} result:`, JSON.stringify(result));
  if (!result.success) {
    throw new Error(`RameeGlobalPay rejected the IDR request (HTTP ${result.httpStatus}): ${result.message || "no message"}`);
  }
  return result.data || {};
}

// POST /order/generate -> data { url, orderid (G...), merchantid }
async function createCheckout({ orderid, amountIdr }) {
  if (!reference.test(orderid) || !Number.isSafeInteger(amountIdr) || amountIdr < 1) {
    throw new Error("Invalid RameeGlobalPay IDR deposit.");
  }
  const data = unwrap("/order/generate", await sdk().createOrder({ currency: "IDR", amount: amountIdr, orderid }));
  if (data.merchantid !== orderid || !reference.test(data.orderid || "") || !String(data.url || "").startsWith("https://")) {
    throw new Error("Invalid RameeGlobalPay IDR checkout response.");
  }
  return { providerOrderId: data.orderid, url: data.url };
}

// POST /order/status -> data { orderid, merchantid, amount, status }
async function depositStatus(orderid) {
  if (!reference.test(orderid)) throw new Error("Invalid RameeGlobalPay IDR deposit reference.");
  return unwrap("/order/status", await sdk().getOrderStatus(orderid));
}

// Callback body { agentCode, data }: check the agent, then decrypt with the SDK.
function decodeDepositCallback({ agentCode, data } = {}) {
  if (agentCode !== config().agentCode) throw new Error("Invalid RameeGlobalPay IDR callback agent.");
  const event = sdk().decrypt(data);
  if (event?.service !== "PayIn" || event.currency !== "IDR" || !reference.test(event.merchantid || "")) {
    throw new Error("Invalid IDR deposit callback.");
  }
  return event;
}

module.exports = { config, createCheckout, depositStatus, decodeDepositCallback, reference };
