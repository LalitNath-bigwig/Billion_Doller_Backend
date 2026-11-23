const { createCipheriv, createDecipheriv, randomBytes } = require("node:crypto");

// RameeGlobalPay client for Indonesian rupiah (IDR) pay-ins, written to
// https://member.rameeglobalpay.com/docs/ and kept separate from the LKR client.
//
// Encryption (docs: "Authentication & encryption"):
//   AES-256-GCM, key = the 32 bytes of the access key string (no derivation),
//   random 12-byte IV per message, 16-byte tag, no AAD,
//   data = Base64(IV + tag + ciphertext). Callbacks use the same layout.

const IV_BYTES = 12;
const TAG_BYTES = 16;
const TIMEOUT_MS = 30000; // docs sample uses 30 s
const reference = /^[a-zA-Z0-9]{4,35}$/; // docs: letters and digits, 4-35 characters
const MAX_GATEWAY_AMOUNT = 100000; // docs: "greater than 0 and at most 100,000"

function createIdrCipher(accessKey) {
  if (typeof accessKey !== "string" || Buffer.byteLength(accessKey, "utf8") !== 32) {
    throw new Error("Use the 32-character RameeGlobalPay IDR access key.");
  }
  const key = Buffer.from(accessKey, "utf8");
  return {
    encrypt(payload) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
      const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
    },
    decrypt(data) {
      if (typeof data !== "string" || data.length > 64 * 1024) throw new Error("Invalid RameeGlobalPay IDR data.");
      const raw = Buffer.from(data, "base64");
      if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error("Invalid RameeGlobalPay IDR data.");
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
      return JSON.parse(plain.toString("utf8"));
    },
  };
}

const clean = text => String(text).replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 200);

function createIdrClient({ baseUrl, agentCode, accessKey, fetchImpl = fetch, maxAmountIdr = MAX_GATEWAY_AMOUNT, log = console.log }) {
  if (typeof baseUrl !== "string" || !URL.canParse(baseUrl)) {
    throw new Error("Set RAMEE_GLOBAL_IDR_API_BASE to the HTTPS API base URL from the merchant panel.");
  }
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password ||
      base.search || base.hash || !/\/v1\/?$/.test(base.pathname)) {
    throw new Error("Use the provider's HTTPS API base ending in /v1, without credentials or query parameters.");
  }
  if (typeof agentCode !== "string" || !/^[\x21-\x7e]{16}$/.test(agentCode)) {
    throw new Error("Use the 16-character RameeGlobalPay IDR agent code.");
  }
  if (!Number.isSafeInteger(maxAmountIdr) || maxAmountIdr < 1 || maxAmountIdr > MAX_GATEWAY_AMOUNT) {
    throw new Error(`The IDR maximum must be a whole number from 1 to ${MAX_GATEWAY_AMOUNT}.`);
  }
  const cipher = createIdrCipher(accessKey);

  // Every endpoint: POST JSON { data } with the X-Agent-Code header.
  // Docs: responses are plain JSON; authentication errors come back as HTTP 200
  // with success:false, validation/business errors as HTTP 400. Always check success.
  async function request(path, payload) {
    const endpoint = new URL(base);
    endpoint.pathname = base.pathname.replace(/\/$/, "") + path;
    log(`[RameeGlobal IDR] POST ${path} request:`, JSON.stringify(payload));
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-Code": agentCode },
        body: JSON.stringify({ data: cipher.encrypt(payload) }),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      log(`[RameeGlobal IDR] POST ${path} network error: ${error.name}: ${error.message}`);
      throw new Error(error.name === "TimeoutError"
        ? `RameeGlobalPay did not answer within ${TIMEOUT_MS / 1000} s.`
        : "Could not reach RameeGlobalPay.");
    }
    const text = await response.text().catch(() => "");
    log(`[RameeGlobal IDR] POST ${path} response: HTTP ${response.status}\n${text}`);

    let body;
    try { body = JSON.parse(text); } catch {
      throw new Error(`RameeGlobalPay returned HTTP ${response.status} without valid JSON.`);
    }
    // The live gateway sometimes wraps replies in the callback envelope; unwrap it.
    if (body && typeof body === "object" && typeof body.data === "string") {
      try {
        body = cipher.decrypt(body.data);
        log(`[RameeGlobal IDR] POST ${path} decrypted response:`, JSON.stringify(body));
      } catch {
        throw new Error(`RameeGlobalPay returned HTTP ${response.status} with data that the IDR access key cannot decrypt.`);
      }
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error(`RameeGlobalPay returned HTTP ${response.status} with an unexpected body.`);
    }
    if (!response.ok || body.success === false) {
      const message = typeof body.message === "string" && body.message.trim() ? clean(body.message) : "no message";
      throw new Error(`RameeGlobalPay rejected the IDR request (HTTP ${response.status}): ${message}`);
    }
    return body;
  }

  return {
    // Docs "Create order": POST /order/generate { currency, amount, orderid }.
    async createCheckout({ orderid, amountIdr }) {
      if (typeof orderid !== "string" || !reference.test(orderid) ||
          !Number.isSafeInteger(amountIdr) || amountIdr < 1 || amountIdr > maxAmountIdr) {
        throw new Error("Invalid RameeGlobalPay IDR deposit.");
      }
      const result = await request("/order/generate", { currency: "IDR", amount: amountIdr, orderid });
      if (result.success !== true || result.merchantid !== orderid ||
          typeof result.orderid !== "string" || !reference.test(result.orderid) ||
          typeof result.url !== "string" || !URL.canParse(result.url)) {
        throw new Error("Invalid RameeGlobalPay IDR checkout response.");
      }
      const url = new URL(result.url);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid RameeGlobalPay IDR checkout URL.");
      return { providerOrderId: result.orderid, url: url.href };
    },

    // Docs "Order status": POST /order/status { orderid }. A found order has
    // no success field; it returns { orderid, merchantid, amount, status }.
    async depositStatus(orderid) {
      if (typeof orderid !== "string" || !reference.test(orderid)) throw new Error("Invalid RameeGlobalPay IDR deposit reference.");
      return request("/order/status", { orderid });
    },

    // Docs "Callbacks": { agentCode, data } with data encrypted by the access key.
    decodeDepositCallback(envelope) {
      if (envelope?.agentCode !== agentCode) throw new Error("Invalid RameeGlobalPay IDR callback agent.");
      const event = cipher.decrypt(envelope.data);
      if (event?.service !== "PayIn" || event.currency !== "IDR" ||
          typeof event.merchantid !== "string" || !reference.test(event.merchantid)) {
        throw new Error("Invalid IDR deposit callback.");
      }
      return event;
    },
  };
}

module.exports = { createIdrClient, createIdrCipher, reference };
