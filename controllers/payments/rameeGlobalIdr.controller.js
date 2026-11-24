const { randomUUID } = require("node:crypto");
const Account = require("../../models/account.model");
const Order = require("../../models/Order");
const { MIN_DEPOSIT_USD } = require("../../config/depositLimits");
const { balanceWithClaim, runDeposit, IDR_DEPOSIT_PROVIDER: provider } = require("../../services/depositCredit.service");
const { readLkrMinor } = require("../../utils/rameeGlobalProtocol");
const { RaamiClient } = require("../../utils/raamiClient");

// IDR pay-ins through RameeGlobalPay (docs: https://member.rameeglobalpay.com/docs/).
// Flow: controller -> RaamiClient (SDK). IDR is charged in whole rupiah.
//
// Env:
//   RAMEE_GLOBAL_IDR_ENABLED      must be exactly "true"
//   RAMEE_GLOBAL_IDR_AGENT_CODE   16 characters (X-Agent-Code header)
//   RAMEE_GLOBAL_IDR_ACCESS_KEY   32 characters (AES-256-GCM key)
//   RAMEE_GLOBAL_IDR_PER_USD      exchange rate, e.g. 16250 or 16250.50
//   RAMEE_GLOBAL_IDR_MAX_AMOUNT   optional, defaults to 100000 (docs: "at most 100,000")
// IDR never falls back to the RAMEE_GLOBAL_LKR_* credentials.

const reference = /^[a-zA-Z0-9]{4,35}$/; // docs: orderid is letters and digits, 4-35 characters
const providerStatuses = new Set(["PENDING", "FAILED", "SUCCESS", "SETTLED"]);
const durable = { writeConcern: { w: "majority", j: true } };
const DEFAULT_MAX_IDR = 100000;

// Reads and checks the IDR settings. Returns null when IDR is switched off;
// throws when it is on but misconfigured.
function readConfig(env = process.env) {
  if (env.RAMEE_GLOBAL_IDR_ENABLED !== "true") return null;
  const agentCode = env.RAMEE_GLOBAL_IDR_AGENT_CODE || "";
  const accessKey = env.RAMEE_GLOBAL_IDR_ACCESS_KEY || "";
  if (agentCode.length !== 16) throw new Error("Set RAMEE_GLOBAL_IDR_AGENT_CODE to the 16-character agent code.");
  if (Buffer.byteLength(accessKey) !== 32) throw new Error("Set RAMEE_GLOBAL_IDR_ACCESS_KEY to the 32-character access key.");

  let maxAmountIdr = DEFAULT_MAX_IDR;
  if (env.RAMEE_GLOBAL_IDR_MAX_AMOUNT) {
    maxAmountIdr = Number(env.RAMEE_GLOBAL_IDR_MAX_AMOUNT);
    if (!Number.isSafeInteger(maxAmountIdr) || maxAmountIdr < 1) throw new Error("RAMEE_GLOBAL_IDR_MAX_AMOUNT must be a whole number of rupiah.");
  }
  return { agentCode, accessKey, maxAmountIdr };
}

// The SDK returns { success, httpStatus, message, data }. Docs: always check
// success, because auth errors come back as HTTP 200 with success:false.
function unwrap(path, result) {
  console.log(`[RameeGlobalIDR] ${path} result:`, JSON.stringify(result, null, 2));
  if (!result.success) {
    throw new Error(`RameeGlobalPay rejected ${path} (HTTP ${result.httpStatus}): ${result.message || "no message"}`);
  }
  return result.data || {};
}

function createIdrController({
  orders = Order,
  accounts = Account,
  credit = { runDeposit, balanceWithClaim },
  env = process.env,
  makeClient = (agentCode, accessKey) => new RaamiClient("production", agentCode, accessKey),
} = {}) {
  const unavailable = res => res.status(503).json({ success: false, message: "IDR payments are unavailable." });

  function setup(scope) {
    try {
      const config = readConfig(env);
      if (!config) {
        console.error(`[RameeGlobalIDR] ${scope}: disabled, RAMEE_GLOBAL_IDR_ENABLED is not exactly "true"`);
        return null;
      }
      return { config, client: makeClient(config.agentCode, config.accessKey) };
    } catch (error) {
      console.error(`[RameeGlobalIDR] ${scope}: config invalid: ${error.message}`);
      return null;
    }
  }

  // A gateway result (callback or status reply) must match our order exactly.
  function validateResult(order, event, allowProviderBinding) {
    if (!event || event.merchantid !== order.orderid || typeof event.orderid !== "string" ||
        !reference.test(event.orderid) || (event.currency !== undefined && event.currency !== "IDR") ||
        (order.providerOrderId ? order.providerOrderId !== event.orderid : !allowProviderBinding) ||
        !providerStatuses.has(event.status) ||
        readLkrMinor(event.amount, 12) !== (order.rameeGlobalIdr?.amountIdr ?? NaN) * 100) {
      throw new Error("RameeGlobalPay result does not match the IDR deposit.");
    }
  }

  // Applies a PENDING/SUCCESS/SETTLED/FAILED result under the deposit lock.
  // Docs: the same callback can arrive more than once, so this credits at most once.
  async function applyResult(order, event, allowProviderBinding = false) {
    validateResult(order, event, allowProviderBinding);
    return credit.runDeposit(order.orderid, async locked => {
      if (locked.provider !== provider) throw new Error("IDR deposit provider changed.");
      validateResult(locked, event, allowProviderBinding);
      if (locked.status === "FAILED" && ["SUCCESS", "SETTLED"].includes(event.status)) {
        throw new Error("Conflicting IDR deposit status requires reconciliation.");
      }
      if (locked.status === "FAILED") return "FAILED";
      const providerBound = Boolean(locked.providerOrderId);
      locked.providerOrderId = event.orderid;
      if (event.status === "PENDING") {
        if (!providerBound) await locked.save({ w: "majority", j: true });
        return "PENDING";
      }
      if (event.status === "FAILED") {
        locked.status = "FAILED";
        await locked.save({ w: "majority", j: true });
        return "FAILED";
      }
      if (locked.status !== "PENDING" || locked.creditedAmount > 0 || !Number.isFinite(locked.amount) || locked.amount <= 0) {
        throw new Error("The IDR deposit requires reconciliation before a credit.");
      }
      await credit.balanceWithClaim({
        login: locked.accountNo,
        type: 2,
        balance: locked.amount.toFixed(2),
        comment: `DEP-${locked.orderid}`.slice(0, 31),
      });
      locked.status = "SUCCESS";
      await locked.save({ w: "majority", j: true });
      return "SUCCESS";
    }, () => "SUCCESS", { requireDurableOutcome: true, provider });
  }

  // POST /api/payment/ramee-global/idr/deposit  { accountNo, amount }  (whole rupiah)
  // Docs: Create a pay-in order -> POST /order/generate
  async function createDeposit(req, res) {
    const ctx = setup("createDeposit");
    if (!ctx) return unavailable(res);

    let idrMinorPerUsd; // IDR-per-USD in hundredths, e.g. 16250.50 -> 1625050
    try {
      idrMinorPerUsd = readLkrMinor(env.RAMEE_GLOBAL_IDR_PER_USD, 9);
      if (idrMinorPerUsd <= 0) throw new Error("must be greater than 0");
    } catch (error) {
      console.error(`[RameeGlobalIDR] createDeposit: RAMEE_GLOBAL_IDR_PER_USD invalid (use e.g. 16250 or 16250.50): ${error.message}`);
      return unavailable(res);
    }

    const raw = typeof req.body?.amount === "number" ? String(req.body.amount) : req.body?.amount;
    if (typeof raw !== "string" || !/^\d{1,12}$/.test(raw.trim())) {
      return res.status(400).json({ success: false, message: "Enter a valid IDR amount in whole rupiah." });
    }
    const amountIdr = Number(raw.trim());
    const usdCents = Math.floor(amountIdr * 100 * 100 / idrMinorPerUsd);
    if (amountIdr < 1 || amountIdr > ctx.config.maxAmountIdr || !Number.isSafeInteger(usdCents) || usdCents < MIN_DEPOSIT_USD * 100) {
      return res.status(400).json({ success: false, message: "Invalid IDR deposit amount or exchange quote." });
    }

    const account = await accounts.findOne({ accountNo: Number(req.body.accountNo) }).select("_id accountNo");
    if (!account) return res.status(404).json({ success: false, message: "Account not found." });

    // 23 characters, inside the gateway's 4-35 limit. Saved before calling the
    // gateway so a callback always finds its order.
    const orderid = `IDR${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const amountUSD = usdCents / 100;
    try {
      await orders.create([{
        account: account._id, accountNo: String(account.accountNo), orderid, amount: amountUSD,
        status: "PENDING", provider, rameeGlobalIdr: { amountIdr, idrMinorPerUsd },
      }], durable);

      const data = unwrap("/order/generate", await ctx.client.createOrder({ currency: "IDR", amount: amountIdr, orderid }));
      // Docs: response { url, orderid (our system ref, starts with G), merchantid (echoes ours) }
      if (data.merchantid !== orderid || !reference.test(data.orderid || "") || !String(data.url || "").startsWith("https://")) {
        throw new Error("Invalid RameeGlobalPay IDR checkout response.");
      }

      const saved = await orders.updateOne({
        orderid, provider,
        $or: [{ providerOrderId: { $exists: false } }, { providerOrderId: data.orderid }],
      }, { $set: { providerOrderId: data.orderid } }, durable);
      if (saved.matchedCount !== 1) throw new Error("The IDR checkout requires reconciliation.");

      return res.status(201).json({ success: true, orderid, url: data.url, amountIdr, amountUSD });
    } catch (error) {
      console.error(`[RameeGlobalIDR] createDeposit: checkout failed for account ${account.accountNo}: ${error.message}`);
      return res.status(502).json({ success: false, message: "IDR checkout could not be confirmed." });
    }
  }

  // RameeGlobalPay sends every currency to one webhook URL. This handler only
  // takes IDR pay-in events and otherwise calls next() so the LKR handler runs.
  // Docs (Callbacks): check agentCode, decrypt data, find the order by merchantid.
  async function depositCallback(req, res, next) {
    let config;
    try { config = readConfig(env); } catch { config = null; }
    if (!config) return next(); // IDR off or misconfigured: leave it to the LKR handler.

    console.log("[RameeGlobalIDR] callback raw body:", JSON.stringify(req.body));
    const { agentCode, data } = req.body || {};
    if (agentCode !== config.agentCode) return next();
    let event;
    try { event = makeClient(config.agentCode, config.accessKey).decrypt(data); } catch (error) {
      console.log(`[RameeGlobalIDR] callback decrypt failed: ${error.message}`);
      return next();
    }
    console.log("[RameeGlobalIDR] callback decrypted event:", JSON.stringify(event, null, 2));
    if (event?.service !== "PayIn" || event.currency !== "IDR" || !reference.test(event.merchantid || "")) return next();

    try {
      const order = await orders.findOne({ orderid: event.merchantid, provider });
      if (!order) return res.status(404).json({ success: false, message: "IDR deposit not found." });
      await applyResult(order, event);
      return res.json({ success: true });
    } catch (error) {
      console.error(`[RameeGlobalIDR] depositCallback: ${error.message}`);
      return res.status(503).json({ success: false, message: "IDR deposit requires reconciliation." });
    }
  }

  // POST /api/payment/ramee-global/idr/deposits/:orderid/refresh
  // Docs: Order status -> POST /order/status. A found reply has no success field.
  async function refreshDeposit(req, res) {
    const ctx = setup("refreshDeposit");
    if (!ctx) return unavailable(res);
    const { orderid } = req.params;
    try {
      const order = typeof orderid === "string" && reference.test(orderid) ? await orders.findOne({ orderid, provider }) : null;
      if (!order) return res.status(404).json({ success: false, message: "IDR deposit not found." });
      const event = unwrap("/order/status", await ctx.client.getOrderStatus(orderid));
      const status = await applyResult(order, event, true);
      return res.json({ success: true, status });
    } catch (error) {
      console.error(`[RameeGlobalIDR] refreshDeposit: ${error.message}`);
      return res.status(503).json({ success: false, message: "IDR deposit requires reconciliation." });
    }
  }

  return { createDeposit, depositCallback, refreshDeposit };
}

module.exports = { ...createIdrController(), createIdrController, readConfig };
