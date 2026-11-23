const { randomUUID } = require("node:crypto");
const { MIN_DEPOSIT_USD } = require("../config/depositLimits");
const { IDR_DEPOSIT_PROVIDER: provider } = require("./depositCredit.service");
const { createLkrClient, reference } = require("../utils/rameeGlobalLkrClient");
const { readLkrMinor } = require("../utils/rameeGlobalProtocol");

// Indonesian rupiah deposits through RameeGlobalPay. Same gateway, credentials
// and callback envelope as LKR; IDR is charged in whole rupiah (no decimals).
// Mirrors rameeGlobalLkrDeposit.service.js so the live LKR flow is untouched.
const durable = { writeConcern: { w: "majority", j: true } };
const providerStatuses = new Set(["PENDING", "FAILED", "SUCCESS", "SETTLED"]);
const DEFAULT_MAX_IDR = 100000; // gateway documents "at most 100,000" per order
const AMOUNT_DIGITS = 12;

function createIdrDepositService({ client, orders, runDeposit, balanceWithClaim, maxAmountIdr = DEFAULT_MAX_IDR }) {
  async function createDeposit({ account, amountIdr, idrMinorPerUsd }) {
    // idrMinorPerUsd is IDR-per-USD in hundredths, e.g. 16250.50 -> 1625050.
    const usdCents = Math.floor(amountIdr * 100 * 100 / idrMinorPerUsd);
    if (!Number.isSafeInteger(amountIdr) || amountIdr < 1 || amountIdr > maxAmountIdr ||
        !Number.isSafeInteger(idrMinorPerUsd) || idrMinorPerUsd < 1 ||
        !Number.isSafeInteger(usdCents) || usdCents < MIN_DEPOSIT_USD * 100) {
      throw new RangeError("Invalid IDR deposit amount or exchange quote.");
    }
    const orderid = `IDR${randomUUID().replace(/-/g, "")}`;
    const amountUSD = usdCents / 100;
    await orders.create([{
      account: account._id, accountNo: String(account.accountNo), orderid, amount: amountUSD,
      status: "PENDING", provider, rameeGlobalIdr: { amountIdr, idrMinorPerUsd },
    }], durable);

    const { providerOrderId, url } = await client.createCheckout({ orderid, amountLkrMinor: amountIdr * 100 });
    const saved = await orders.updateOne({
      orderid, provider,
      $or: [{ providerOrderId: { $exists: false } }, { providerOrderId }],
    }, { $set: { providerOrderId } }, durable);
    if (saved.matchedCount !== 1) throw new Error("The IDR checkout requires reconciliation.");
    return { orderid, url, amountIdr, amountUSD };
  }

  function validateResult(order, event, allowProviderBinding) {
    if (!event || event.merchantid !== order.orderid || typeof event.orderid !== "string" ||
        !reference.test(event.orderid) || (event.currency !== undefined && event.currency !== "IDR") ||
        (order.providerOrderId ? order.providerOrderId !== event.orderid : !allowProviderBinding) ||
        !providerStatuses.has(event.status) ||
        readLkrMinor(event.amount, AMOUNT_DIGITS) !== (order.rameeGlobalIdr?.amountIdr ?? NaN) * 100) {
      throw new Error("RameeGlobalPay result does not match the IDR deposit.");
    }
  }

  async function applyResult(order, event, allowProviderBinding = false) {
    validateResult(order, event, allowProviderBinding);
    return runDeposit(order.orderid, async locked => {
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
      await balanceWithClaim({
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

  return {
    createDeposit,
    async applyCallback(event) {
      const order = await orders.findOne({ orderid: event.merchantid, provider });
      return order ? applyResult(order, event) : null;
    },
    async refresh(orderid) {
      if (typeof orderid !== "string" || !reference.test(orderid)) return null;
      const order = await orders.findOne({ orderid, provider });
      if (!order) return null;
      return applyResult(order, await client.depositStatus(orderid), true);
    },
  };
}

function maxAmountIdr(env = process.env) {
  const raw = env.RAMEE_GLOBAL_IDR_MAX_AMOUNT;
  if (raw === undefined || raw === "") return DEFAULT_MAX_IDR;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("RAMEE_GLOBAL_IDR_MAX_AMOUNT must be a whole number of rupiah.");
  return value;
}

// IDR has its own RameeGlobalPay credentials, separate from LKR. There is no
// fallback to the RAMEE_GLOBAL_LKR_* values, so the two accounts never mix.
function idrClient(env = process.env) {
  if (env.RAMEE_GLOBAL_IDR_ENABLED !== "true") return null;
  return createLkrClient({
    baseUrl: env.RAMEE_GLOBAL_IDR_API_BASE,
    agentCode: env.RAMEE_GLOBAL_IDR_AGENT_CODE,
    accessKey: env.RAMEE_GLOBAL_IDR_ACCESS_KEY,
    currency: "IDR",
    maxMinor: maxAmountIdr(env) * 100,
    httpErrorDetail: true,
  });
}

module.exports = { createIdrDepositService, idrClient, maxAmountIdr };
