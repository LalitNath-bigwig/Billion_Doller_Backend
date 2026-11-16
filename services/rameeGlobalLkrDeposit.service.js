const { randomUUID } = require("node:crypto");
const { MIN_DEPOSIT_USD } = require("../config/depositLimits");
const { LKR_DEPOSIT_PROVIDER: provider } = require("./depositCredit.service");
const { createLkrClient, reference } = require("../utils/rameeGlobalLkrClient");
const { readLkrMinor } = require("../utils/rameeGlobalProtocol");

const durable = { writeConcern: { w: "majority", j: true } };
const providerStatuses = new Set(["PENDING", "FAILED", "SUCCESS", "SETTLED"]);

function createLkrDepositService({ client, orders, runDeposit, balanceWithClaim }) {
  async function createDeposit({ account, amountLkrMinor, lkrMinorPerUsd }) {
    const usdCents = Math.floor(amountLkrMinor * 100 / lkrMinorPerUsd);
    if (!Number.isSafeInteger(amountLkrMinor) || amountLkrMinor < 1 || amountLkrMinor > 10000000 ||
        !Number.isSafeInteger(lkrMinorPerUsd) || lkrMinorPerUsd < 1 ||
        !Number.isSafeInteger(usdCents) || usdCents < MIN_DEPOSIT_USD * 100) {
      throw new RangeError("Invalid LKR deposit amount or exchange quote.");
    }
    const orderid = `LKR${randomUUID().replace(/-/g, "")}`;
    const amountUSD = usdCents / 100;
    await orders.create([{
      account: account._id, accountNo: String(account.accountNo), orderid, amount: amountUSD,
      status: "PENDING", provider, rameeGlobalLkr: { amountLkrMinor, lkrMinorPerUsd },
    }], durable);

    const { providerOrderId, url } = await client.createCheckout({ orderid, amountLkrMinor });
    const saved = await orders.updateOne({
      orderid, provider,
      $or: [{ providerOrderId: { $exists: false } }, { providerOrderId }],
    }, { $set: { providerOrderId } }, durable);
    if (saved.matchedCount !== 1) throw new Error("The LKR checkout requires reconciliation.");
    return { orderid, url, amountLkr: amountLkrMinor / 100, amountUSD };
  }

  function validateResult(order, event, allowProviderBinding) {
    if (!event || event.merchantid !== order.orderid || typeof event.orderid !== "string" ||
        !reference.test(event.orderid) || (event.currency !== undefined && event.currency !== "LKR") ||
        (order.providerOrderId ? order.providerOrderId !== event.orderid : !allowProviderBinding) ||
        !providerStatuses.has(event.status) || readLkrMinor(event.amount) !== order.rameeGlobalLkr?.amountLkrMinor) {
      throw new Error("RameeGlobalPay result does not match the LKR deposit.");
    }
  }

  async function applyResult(order, event, allowProviderBinding = false) {
    validateResult(order, event, allowProviderBinding);
    return runDeposit(order.orderid, async locked => {
      if (locked.provider !== provider) throw new Error("LKR deposit provider changed.");
      validateResult(locked, event, allowProviderBinding);
      if (locked.status === "FAILED" && ["SUCCESS", "SETTLED"].includes(event.status)) {
        throw new Error("Conflicting LKR deposit status requires reconciliation.");
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
        throw new Error("The LKR deposit requires reconciliation before a credit.");
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

function configuredClient(env = process.env) {
  return createLkrClient({
    baseUrl: env.RAMEE_GLOBAL_LKR_API_BASE,
    agentCode: env.RAMEE_GLOBAL_LKR_AGENT_CODE,
    accessKey: env.RAMEE_GLOBAL_LKR_ACCESS_KEY,
  });
}

function stagingClient(env = process.env) {
  return env.RAMEE_GLOBAL_LKR_STAGING_ENABLED === "true" ? configuredClient(env) : null;
}

module.exports = { createLkrDepositService, configuredClient, stagingClient };
