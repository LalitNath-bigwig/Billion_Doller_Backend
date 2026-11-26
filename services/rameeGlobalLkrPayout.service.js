const { RaamiClient } = require("../utils/raamiClient");
const { readLkrMinor } = require("../utils/rameeGlobalProtocol");
const { MIN_WITHDRAWAL_USD } = require("../config/withdrawalLimits");

// LKR withdrawals through RameeGlobalPay.
//   Bank list      RaamiClient.getPayoutMethods("LKR")
//   Create payout  RaamiClient.createPayout(...)
//   Result         arrives on the payout callback (rameeGlobalLkrPayoutCallback.service.js),
//                  which matches the withdrawal on orderid + rameeGlobalLkr.payoutId.
//
// Env:
//   RAMEE_GLOBAL_LKR_AGENT_CODE, RAMEE_GLOBAL_LKR_ACCESS_KEY   same credentials the LKR deposit uses
//   RAMEE_GLOBAL_LKR_STAGING_LKR_PER_USD                       rate, e.g. 300 or 300.50

function createLkrPayoutService({
  withdrawals,
  env = process.env,
  makeClient = (agentCode, accessKey) => new RaamiClient("production", agentCode, accessKey),
} = {}) {
  // Returns { client, lkrMinorPerUsd } or null when LKR is not configured.
  function setup(scope) {
    try {
      const { RAMEE_GLOBAL_LKR_AGENT_CODE: agentCode, RAMEE_GLOBAL_LKR_ACCESS_KEY: accessKey } = env;
      if (!agentCode || !accessKey) throw new Error("LKR agent code or access key is missing.");
      const lkrMinorPerUsd = readLkrMinor(env.RAMEE_GLOBAL_LKR_STAGING_LKR_PER_USD);
      if (lkrMinorPerUsd <= 0) throw new Error("The LKR per USD rate must be greater than 0.");
      return { client: makeClient(agentCode, accessKey), lkrMinorPerUsd };
    } catch (error) {
      console.error(`[RameeGlobalLKR] payout ${scope}: ${error.message}`);
      return null;
    }
  }

  // Checks a withdrawal request before any money moves. Returns
  // { ok: true, amountLkr, usd, bankCode, bankName, account, holder, lkrPerUsd } or { ok: false, status, message }.
  async function prepareRequest(body = {}) {
    const fail = (message, status = 400) => ({ ok: false, status, message });
    const ctx = setup("prepareRequest");
    if (!ctx) return fail("LKR withdrawals are unavailable.", 503);

    let amountMinor;
    try { amountMinor = readLkrMinor(body.amount); } catch {
      return fail("Enter a valid LKR amount with up to two decimal places.");
    }
    if (amountMinor <= 0) return fail("Enter a valid LKR amount with up to two decimal places.");

    // Round the USD debit up to the cent so the client is never under-charged.
    const usdCents = Math.ceil((amountMinor * 100) / ctx.lkrMinorPerUsd);
    const usd = usdCents / 100;
    if (usd < MIN_WITHDRAWAL_USD) return fail(`The minimum withdrawal amount is US$${MIN_WITHDRAWAL_USD}.`);

    const bankCode = typeof body.bankCode === "string" ? body.bankCode.trim() : "";
    const account = ["string", "number"].includes(typeof body.account) ? String(body.account).trim() : "";
    const holder = String(body.accountHolderName || body.name || "").trim();
    if (!bankCode) return fail("Select a bank for the LKR withdrawal.");
    if (!/^[A-Za-z0-9-]{4,34}$/.test(account)) return fail("Enter a valid bank account number.");
    if (!holder || holder.length > 100) return fail("Enter the account holder name.");

    const result = await ctx.client.getPayoutMethods("LKR");
    const methods = result.data?.methods;
    if (!result.success || !Array.isArray(methods)) return fail("The LKR bank list is unavailable. Please try again shortly.", 503);
    const bank = methods.find(method => method.code === bankCode);
    if (!bank) return fail("The selected bank is not supported for LKR withdrawals.");

    return {
      ok: true,
      amountLkr: amountMinor / 100,
      usd,
      bankCode,
      bankName: bank.description || bankCode,
      account,
      holder,
      lkrPerUsd: ctx.lkrMinorPerUsd / 100,
    };
  }

  // Sends an approved LKR withdrawal to RameeGlobalPay. The withdrawal is claimed
  // (Processing) before sending so a double click cannot pay twice. An attempt whose
  // outcome is unknown stays Processing and is never re-sent automatically.
  // Returns { ok, status, code, message, data }.
  async function approve(withdrawal) {
    const ctx = setup("approve");
    if (!ctx) return { ok: false, status: 503, code: "UNAVAILABLE", message: "LKR payouts are unavailable." };

    const bankCode = withdrawal.rameeGlobalLkr?.bankCode;
    if (!bankCode || !withdrawal.account) {
      return { ok: false, status: 400, code: "MISSING_BANK", message: "The bank code or account number is missing. Process this payout manually." };
    }

    const claimed = await withdrawals.findOneAndUpdate(
      { _id: withdrawal._id, currency: "LKR", status: { $in: ["Pending", "Failed"] } },
      { $set: { status: "Processing", processType: "RameeGlobalPay API (LKR)", "rameeGlobalLkr.approvedAt": new Date() } },
      { new: true, writeConcern: { w: "majority", j: true } }
    );
    if (!claimed) return { ok: false, status: 409, code: "IN_PROGRESS", message: "This withdrawal is already being processed." };

    const result = await ctx.client.createPayout({
      currency: "LKR",
      amount: Number(withdrawal.amount),
      orderid: withdrawal.orderid,
      note: "LKR Withdrawal",
      orderDetail: { code: bankCode, account: String(withdrawal.account) },
    });

    const providerOrderId = result.data?.orderid;
    if (result.success && providerOrderId) {
      const updated = await withdrawals.findOneAndUpdate({ _id: withdrawal._id }, {
        $set: { "rameeGlobalLkr.payoutId": providerOrderId, response: result },
      }, { new: true });
      return { ok: true, status: 200, code: "SUBMITTED", message: "LKR payout submitted and awaiting confirmation.", data: updated };
    }

    // No HTTP status, a server error, or a "success" without a payout id: the payout may
    // still have been queued, so leave it Processing for the admin to check.
    const unconfirmed = result.success || !result.httpStatus || result.httpStatus >= 500;
    if (unconfirmed) {
      await withdrawals.updateOne({ _id: withdrawal._id }, { $set: { response: result } });
      return { ok: false, status: 502, code: "UNCONFIRMED", message: "The LKR payout was not confirmed. Check it in the RameeGlobalPay panel before doing anything else." };
    }

    await withdrawals.updateOne({ _id: withdrawal._id }, { $set: { status: "Failed", response: result } });
    return { ok: false, status: 400, code: "REJECTED", message: result.message || "RameeGlobalPay rejected the payout. You can retry, process it manually or reject it to refund." };
  }

  return { prepareRequest, approve };
}

module.exports = { createLkrPayoutService };
