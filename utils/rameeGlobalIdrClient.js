// RameeGlobalPay IDR pay-ins, following https://member.rameeglobalpay.com/docs/ (Node.js helper).
// Reads RAMEE_GLOBAL_IDR_API_BASE, RAMEE_GLOBAL_IDR_AGENT_CODE and RAMEE_GLOBAL_IDR_ACCESS_KEY.
const crypto = require("crypto");

const reference = /^[a-zA-Z0-9]{4,35}$/; // docs: orderid is letters and digits, 4-35 characters

function config() {
  const BASE_URL = (process.env.RAMEE_GLOBAL_IDR_API_BASE || "").replace(/\/$/, "");
  const AGENT_CODE = process.env.RAMEE_GLOBAL_IDR_AGENT_CODE || "";
  const ACCESS_KEY = Buffer.from(process.env.RAMEE_GLOBAL_IDR_ACCESS_KEY || "", "utf8");
  if (!/^https:\/\/[^/]+.*\/v1$/.test(BASE_URL)) throw new Error("Set RAMEE_GLOBAL_IDR_API_BASE to the HTTPS API base URL ending in /v1.");
  if (AGENT_CODE.length !== 16) throw new Error("Set RAMEE_GLOBAL_IDR_AGENT_CODE to the 16-character agent code.");
  if (ACCESS_KEY.length !== 32) throw new Error("Set RAMEE_GLOBAL_IDR_ACCESS_KEY to the 32-character access key.");
  return { BASE_URL, AGENT_CODE, ACCESS_KEY };
}

function encrypt(payload) {
  console.log("[RameeGlobal IDR] encrypt input:", JSON.stringify(payload));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", config().ACCESS_KEY, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const data = Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
  console.log("[RameeGlobal IDR] encrypt output (data):", data);
  return data;
}

function decrypt(data) {
  console.log("[RameeGlobal IDR] decrypt input (data):", data);
  try {
    const raw = Buffer.from(data, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", config().ACCESS_KEY, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    const result = JSON.parse(plain.toString("utf8"));
    console.log("[RameeGlobal IDR] decrypt output:", JSON.stringify(result));
    return result;
  } catch (error) {
    console.log(`[RameeGlobal IDR] decrypt failed: ${error.message}`);
    throw error;
  }
}

async function rameePay(path, payload) {
  const { BASE_URL, AGENT_CODE } = config();
  console.log(`[RameeGlobal IDR] POST ${BASE_URL + path}`);
  let res;
  try {
    res = await fetch(BASE_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Code": AGENT_CODE },
      // RameeGlobalPay's SDK sends agentCode in the body; the docs use the header. Send both.
      body: JSON.stringify({ agentCode: AGENT_CODE, data: encrypt(payload) }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    console.log(`[RameeGlobal IDR] POST ${path} network error: ${error.message}`);
    throw new Error("Could not reach RameeGlobalPay.");
  }
  const text = await res.text();
  console.log(`[RameeGlobal IDR] POST ${path} response: HTTP ${res.status}\n${text}`);

  let body;
  try { body = JSON.parse(text); } catch {
    throw new Error(`RameeGlobalPay returned HTTP ${res.status} without valid JSON.`);
  }
  // The live gateway sometimes encrypts its reply like a callback; decrypt it.
  if (typeof body?.data === "string") {
    try { body = decrypt(body.data); } catch {
      throw new Error(`RameeGlobalPay returned HTTP ${res.status} with data that the IDR access key cannot decrypt.`);
    }
  }
  // Docs: always check success. Auth errors are HTTP 200, validation errors HTTP 400.
  if (!res.ok || body?.success === false) {
    throw new Error(`RameeGlobalPay rejected the IDR request (HTTP ${res.status}): ${body?.message || "no message"}`);
  }
  return body;
}

// POST /order/generate -> { success, url, orderid (G...), merchantid }
async function createCheckout({ orderid, amountIdr }) {
  if (!reference.test(orderid) || !Number.isSafeInteger(amountIdr) || amountIdr < 1) {
    throw new Error("Invalid RameeGlobalPay IDR deposit.");
  }
  const res = await rameePay("/order/generate", { currency: "IDR", amount: amountIdr, orderid });
  if (res.merchantid !== orderid || !reference.test(res.orderid || "") || !String(res.url || "").startsWith("https://")) {
    throw new Error("Invalid RameeGlobalPay IDR checkout response.");
  }
  return { providerOrderId: res.orderid, url: res.url };
}

// POST /order/status -> { orderid, merchantid, amount, status }
function depositStatus(orderid) {
  if (!reference.test(orderid)) throw new Error("Invalid RameeGlobalPay IDR deposit reference.");
  return rameePay("/order/status", { orderid });
}

// Callback body { agentCode, data }: check the agent, then decrypt.
function decodeDepositCallback({ agentCode, data } = {}) {
  if (agentCode !== config().AGENT_CODE) throw new Error("Invalid RameeGlobalPay IDR callback agent.");
  const event = decrypt(data);
  if (event?.service !== "PayIn" || event.currency !== "IDR" || !reference.test(event.merchantid || "")) {
    throw new Error("Invalid IDR deposit callback.");
  }
  return event;
}

module.exports = { config, encrypt, decrypt, rameePay, createCheckout, depositStatus, decodeDepositCallback, reference };
