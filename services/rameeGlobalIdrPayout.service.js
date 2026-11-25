const { RaamiClient } = require("../utils/raamiClient");
const { MIN_WITHDRAWAL_USD } = require("../config/withdrawalLimits");

// IDR withdrawals through RameeGlobalPay (docs: https://member.rameeglobalpay.com/docs/).
//   Bank list      POST /payout/methods   -> RaamiClient.getPayoutMethods("IDR")
//   Create payout  POST /payout/request   -> RaamiClient.createPayout(...)
//   Status         POST /payout/status    -> RaamiClient.getPayoutStatus(...)
//   Callback       service "PayOut", matched on merchantid (our payout orderid)
//
// Env (IDR never falls back to the LKR credentials):
//   RAMEE_GLOBAL_IDR_ENABLED             must be exactly "true"
//   RAMEE_GLOBAL_IDR_AGENT_CODE          16 characters
//   RAMEE_GLOBAL_IDR_ACCESS_KEY          32 characters
//   RAMEE_GLOBAL_IDR_PER_USD             rate, e.g. 16250 or 16250.50
//   RAMEE_GLOBAL_IDR_WITHDRAWAL_MIN      optional, whole rupiah, default 10000
//   RAMEE_GLOBAL_IDR_WITHDRAWAL_MAX      optional, whole rupiah, default 100000000

const DEFAULT_MIN_IDR = 10000;
const DEFAULT_MAX_IDR = 100000000;
const METHODS_TTL_MS = 10 * 60 * 1000; // docs: the list changes rarely, cache for a few hours
const payoutReference = /^[A-Za-z0-9]{10,45}$/; // docs: payout orderid, letters and digits, 10-45 chars
const finalStatuses = new Map([["SUCCESS", "Completed"], ["FAILED", "Failed"], ["REFUNDED", "Failed"]]);
const durable = { writeConcern: { w: "majority", j: true } };

// Returns null when IDR is switched off; throws when it is on but misconfigured.
function readIdrPayoutConfig(env = process.env) {
  if (env.RAMEE_GLOBAL_IDR_ENABLED !== "true") return null;
  const agentCode = env.RAMEE_GLOBAL_IDR_AGENT_CODE || "";
  const accessKey = env.RAMEE_GLOBAL_IDR_ACCESS_KEY || "";
  if (agentCode.length !== 16) throw new Error("Set RAMEE_GLOBAL_IDR_AGENT_CODE to the 16-character agent code.");
  if (Buffer.byteLength(accessKey) !== 32) throw new Error("Set RAMEE_GLOBAL_IDR_ACCESS_KEY to the 32-character access key.");

  const idrPerUsd = Number(env.RAMEE_GLOBAL_IDR_PER_USD);
  if (!Number.isFinite(idrPerUsd) || idrPerUsd <= 0) throw new Error("Set RAMEE_GLOBAL_IDR_PER_USD to the IDR-per-USD rate.");

  const whole = (name, fallback) => {
    if (!env[name]) return fallback;
    const value = Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a whole number of rupiah.`);
    return value;
  };
  const minIdr = whole("RAMEE_GLOBAL_IDR_WITHDRAWAL_MIN", DEFAULT_MIN_IDR);
  const maxIdr = whole("RAMEE_GLOBAL_IDR_WITHDRAWAL_MAX", DEFAULT_MAX_IDR);
  if (minIdr > maxIdr) throw new Error("RAMEE_GLOBAL_IDR_WITHDRAWAL_MIN is above the maximum.");
  return { agentCode, accessKey, idrPerUsd, minIdr, maxIdr };
}

function createIdrPayoutService({
  withdrawals,
  env = process.env,
  makeClient = (agentCode, accessKey) => new RaamiClient("production", agentCode, accessKey),
  now = () => Date.now(),
} = {}) {
  let methodsCache = { at: 0, methods: null };

  function setup(scope) {
    try {
      const config = readIdrPayoutConfig(env);
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

  // Bank list for the withdrawal form. { ok: true, methods } or { ok: false, status, message }.
  async function loadMethods() {
    if (methodsCache.methods && now() - methodsCache.at < METHODS_TTL_MS) return { ok: true, methods: methodsCache.methods };
    const ctx = setup("loadMethods");
    if (!ctx) return { ok: false, status: 503, message: "IDR withdrawals are unavailable." };
    const result = await ctx.client.getPayoutMethods("IDR");
    const list = result.data?.methods;
    if (!result.success || !Array.isArray(list)) {
      return { ok: false, status: result.httpStatus >= 400 ? result.httpStatus : 502, message: result.message || "Failed to get methods" };
    }
    const methods = list.map(({ id, code, description }) => ({ id, code, description }));
    methodsCache = { at: now(), methods };
    return { ok: true, methods };
  }

  // Checks a withdrawal request before any money moves. Returns
  // { ok: true, amountIdr, usd, bankCode, bankName, account, holder, idrPerUsd } or { ok: false, status, message }.
  async function prepareRequest(body = {}) {
    const ctx = setup("prepareRequest");
    if (!ctx) return { ok: false, status: 503, message: "IDR withdrawals are unavailable." };
    const { minIdr, maxIdr, idrPerUsd } = ctx.config;
    const fail = (message, status = 400) => ({ ok: false, status, message });
    const fmt = n => n.toLocaleString("en-GB");

    const raw = typeof body.amount === "number" ? String(body.amount) : body.amount;
    if (typeof raw !== "string" || !/^\d{1,12}$/.test(raw.trim())) return fail("Enter a valid IDR amount in whole rupiah.");
    const amountIdr = Number(raw.trim());
    if (amountIdr < minIdr) return fail(`The minimum withdrawal amount is IDR ${fmt(minIdr)}.`);
    if (amountIdr > maxIdr) return fail(`The maximum withdrawal amount is IDR ${fmt(maxIdr)}.`);

    // Round the USD debit up to the cent so the client is never under-charged.
    const usd = Math.ceil((amountIdr / idrPerUsd) * 100 - 1e-9) / 100;
    if (usd < MIN_WITHDRAWAL_USD) return fail(`The minimum withdrawal amount is US$${MIN_WITHDRAWAL_USD} (about IDR ${fmt(Math.ceil(MIN_WITHDRAWAL_USD * idrPerUsd))}).`);

    const bankCode = typeof body.bankCode === "string" ? body.bankCode.trim() : "";
    const account = typeof body.account === "string" || typeof body.account === "number" ? String(body.account).trim() : "";
    const holder = String(body.accountHolderName || body.name || "").trim();
    if (!bankCode) return fail("Select a bank for the IDR withdrawal.");
    if (!/^\d{5,20}$/.test(account)) return fail("Enter a valid bank account number (digits only).");
    if (!holder || holder.length > 100) return fail("Enter the account holder name.");

    let loaded;
    try { loaded = await loadMethods(); } catch (error) {
      console.error(`[RameeGlobalIDR] prepareRequest: bank list failed: ${error.message}`);
      return fail("The IDR bank list is unavailable. Please try again shortly.", 503);
    }
    if (!loaded.ok) return fail("The IDR bank list is unavailable. Please try again shortly.", 503);
    const bank = loaded.methods.find(method => method.code === bankCode);
    if (!bank) return fail("The selected bank is not supported for IDR withdrawals.");

    return { ok: true, amountIdr, usd, bankCode, bankName: bank.description, account, holder, idrPerUsd };
  }

  // Sends an approved IDR withdrawal to RameeGlobalPay. Docs: a rejected or
  // failed reply may still have queued the payout, so an attempt whose outcome
  // is unknown stays Processing (needsReview) and is checked with Payout status
  // before anything is sent again. Funds are never refunded here.
  async function approve(withdrawal) {
    const ctx = setup("approve");
    if (!ctx) return { ok: false, status: 503, code: "UNAVAILABLE", message: "IDR payouts are unavailable." };
    const { client } = ctx;
    const idr = withdrawal.rameeGlobalIdr || {};
    const bankCode = idr.bankCode;
    if (!bankCode || !withdrawal.account) {
      return { ok: false, status: 400, code: "MISSING_BANK", message: "The bank code or account number is missing. Process this payout manually." };
    }

    let payoutOrderId = withdrawal.orderid;
    let attempts = idr.attempts || 0;

    if (idr.payoutOrderId) {
      payoutOrderId = idr.payoutOrderId;
      const check = await client.getPayoutStatus(payoutOrderId);
      const providerStatus = check.data?.status;
      if (check.success && (providerStatus === "SUCCESS" || providerStatus === "PENDING")) {
        const done = providerStatus === "SUCCESS";
        const updated = await withdrawals.findOneAndUpdate({ _id: withdrawal._id, currency: "IDR" }, {
          $set: {
            status: done ? "Completed" : "Processing",
            "rameeGlobalIdr.providerStatus": providerStatus,
            "rameeGlobalIdr.needsReview": false,
            ...(done ? { transactionReference: check.data?.utr || "", response: check.data } : {}),
          },
        }, { new: true });
        return { ok: true, status: 200, code: providerStatus, message: done ? "The payout was already completed." : "The payout is still being processed.", data: updated, completed: done ? updated : null };
      }
      const neverCreated = !check.success && /invalid transaction id/i.test(check.message || "");
      const failed = check.success && (providerStatus === "FAILED" || providerStatus === "REFUNDED");
      if (!neverCreated && !failed) {
        return { ok: false, status: 409, code: "UNCONFIRMED", message: "The last payout attempt could not be confirmed. Try again shortly." };
      }
      if (failed) { attempts += 1; payoutOrderId = `${withdrawal.orderid}R${attempts}`; }
    }

    // Claim before sending so a double click cannot pay twice.
    const claimed = await withdrawals.findOneAndUpdate({
      _id: withdrawal._id,
      currency: "IDR",
      $or: [{ status: { $in: ["Pending", "Failed"] } }, { status: "Processing", "rameeGlobalIdr.needsReview": true }],
    }, {
      $set: {
        status: "Processing",
        processType: "RameeGlobalPay API (IDR)",
        "rameeGlobalIdr.payoutOrderId": payoutOrderId,
        "rameeGlobalIdr.attempts": attempts,
        "rameeGlobalIdr.approvedAt": new Date(),
        "rameeGlobalIdr.needsReview": true,
      },
    }, { new: true, ...durable });
    if (!claimed) return { ok: false, status: 409, code: "IN_PROGRESS", message: "This withdrawal is already being processed." };

    const result = await client.createPayout({
      currency: "IDR",
      amount: Number(withdrawal.amount),
      orderid: payoutOrderId,
      note: "IDR Withdrawal",
      orderDetail: { code: bankCode, account: String(withdrawal.account) },
    });
    console.log("[RameeGlobalIDR] /payout/request result:", JSON.stringify(result, null, 2));

    if (result.success) {
      const updated = await withdrawals.findOneAndUpdate({ _id: withdrawal._id }, {
        $set: {
          "rameeGlobalIdr.payoutId": result.data?.orderid || "",
          "rameeGlobalIdr.providerStatus": result.data?.status || "INITIATED",
          "rameeGlobalIdr.needsReview": false,
          response: result,
        },
      }, { new: true });
      return { ok: true, status: 200, code: "SUBMITTED", message: "IDR payout submitted and awaiting confirmation.", data: updated };
    }

    // Anything that might have queued the payout is treated as unconfirmed.
    const unconfirmed = !result.httpStatus || result.httpStatus >= 500 ||
      /withdrawal request failed|duplicate/i.test(result.message || "");
    if (unconfirmed) {
      await withdrawals.updateOne({ _id: withdrawal._id }, {
        $set: { "rameeGlobalIdr.lastMessage": result.message || "", response: result },
      });
      return { ok: false, status: 502, code: "UNCONFIRMED", message: "The payout request was not confirmed. Approve again to check its status before anything is re-sent." };
    }

    await withdrawals.updateOne({ _id: withdrawal._id }, {
      $set: {
        status: "Failed",
        "rameeGlobalIdr.needsReview": false,
        "rameeGlobalIdr.providerStatus": result.data?.status || "FAILED",
        "rameeGlobalIdr.lastMessage": result.message || "",
        response: result,
      },
    });
    return { ok: false, status: 400, code: "REJECTED", message: result.message || "RameeGlobalPay rejected the payout. You can retry, process it manually or reject it to refund." };
  }

  // Payout callback. Returns null when it isn't an IDR event (so the LKR
  // handler can run), otherwise { status, completed? }.
  // Docs: check agentCode, decrypt, find the order by merchantid, be idempotent.
  async function handleCallback(body) {
    let config;
    try { config = readIdrPayoutConfig(env); } catch { config = null; }
    if (!config) return null;
    if (body?.agentCode !== config.agentCode) return null;

    let event;
    try { event = makeClient(config.agentCode, config.accessKey).decrypt(body.data); } catch { return null; }
    if (event?.service !== "PayOut") return null;
    if (typeof event.merchantid !== "string" || !payoutReference.test(event.merchantid)) return { status: 400 };
    if (event.status !== "PENDING" && !finalStatuses.has(event.status)) return { status: 400 };

    const withdrawal = await withdrawals.findOne({ currency: "IDR", "rameeGlobalIdr.payoutOrderId": event.merchantid });
    if (!withdrawal) return { status: 404 };
    if (Number(event.amount) !== Number(withdrawal.amount)) return { status: 400 };

    const target = finalStatuses.get(event.status);
    if (!target) return { status: 200 }; // PENDING: nothing final yet

    const updated = await withdrawals.findOneAndUpdate({ _id: withdrawal._id, status: "Processing" }, {
      $set: {
        status: target,
        "rameeGlobalIdr.providerStatus": event.status,
        "rameeGlobalIdr.payoutId": event.orderid || withdrawal.rameeGlobalIdr?.payoutId || "",
        "rameeGlobalIdr.needsReview": false,
        ...(target === "Completed" ? { transactionReference: event.utr || "" } : {}),
        response: event,
      },
    }, { new: true, ...durable });
    if (updated) return { status: 200, completed: target === "Completed" ? updated : null };
    return { status: withdrawal.status === target ? 200 : 409 };
  }

  // Rate and limits the withdrawal form shows (the request itself is re-checked server side).
  function quote() {
    const ctx = setup("quote");
    if (!ctx) return null;
    const { idrPerUsd, minIdr, maxIdr } = ctx.config;
    return { idrPerUsd, minIdr, maxIdr };
  }

  return { loadMethods, prepareRequest, approve, handleCallback, quote };
}

module.exports = { createIdrPayoutService, readIdrPayoutConfig };
