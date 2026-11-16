const Account = require("../../models/account.model");
const Order = require("../../models/Order");
const Withdrawal = require("../../models/withdrawal");
const { balanceWithClaim, runDeposit } = require("../../services/depositCredit.service");
const { createLkrDepositService, configuredClient, stagingClient } = require("../../services/rameeGlobalLkrDeposit.service");
const { createPayoutCallback } = require("../../services/rameeGlobalLkrPayoutCallback.service");
const { readLkrMinor } = require("../../utils/rameeGlobalProtocol");

function clientForRequest(factory = stagingClient) {
  try { return factory(); } catch { return null; }
}

const unavailable = res => res.status(503).json({ success: false, message: "LKR payment staging is unavailable." });
const service = client => createLkrDepositService({ client, orders: Order, balanceWithClaim, runDeposit });

async function createDeposit(req, res) {
  const client = clientForRequest();
  if (!client) return unavailable(res);
  let lkrMinorPerUsd;
  try {
    lkrMinorPerUsd = readLkrMinor(process.env.RAMEE_GLOBAL_LKR_STAGING_LKR_PER_USD);
    if (lkrMinorPerUsd <= 0) return unavailable(res);
  } catch { return unavailable(res); }

  let amountLkrMinor;
  try { amountLkrMinor = readLkrMinor(req.body.amount); } catch {
    return res.status(400).json({ success: false, message: "Enter a valid LKR amount with up to two decimal places." });
  }
  const account = await Account.findOne({ accountNo: Number(req.body.accountNo) }).select("_id accountNo");
  if (!account) return res.status(404).json({ success: false, message: "Account not found." });
  try {
    const order = await service(client).createDeposit({ account, amountLkrMinor, lkrMinorPerUsd });
    return res.status(201).json({ success: true, ...order });
  } catch (error) {
    if (error instanceof RangeError) return res.status(400).json({ success: false, message: error.message });
    return res.status(502).json({ success: false, message: "LKR checkout could not be confirmed." });
  }
}

async function depositCallback(req, res) {
  const client = clientForRequest(configuredClient);
  if (!client) return unavailable(res);
  let event;
  try { event = client.decodeDepositCallback(req.body); } catch {
    return res.status(400).json({ success: false, message: "Invalid LKR deposit callback." });
  }
  try {
    const status = await service(client).applyCallback(event);
    if (!status) return res.status(404).json({ success: false, message: "LKR deposit not found." });
    return res.json({ success: true });
  } catch {
    return res.status(503).json({ success: false, message: "LKR deposit requires reconciliation." });
  }
}

async function refreshDeposit(req, res) {
  const client = clientForRequest();
  if (!client) return unavailable(res);
  try {
    const status = await service(client).refresh(req.params.orderid);
    if (!status) return res.status(404).json({ success: false, message: "LKR deposit not found." });
    return res.json({ success: true, status });
  } catch {
    return res.status(503).json({ success: false, message: "LKR deposit requires reconciliation." });
  }
}

async function payoutMethods(_req, res) {
  const client = clientForRequest();
  if (!client) return unavailable(res);
  try {
    return res.json({ success: true, currency: "LKR", methods: await client.listPayoutMethods() });
  } catch {
    return res.status(502).json({ success: false, message: "LKR payout methods could not be verified." });
  }
}

async function payoutCallback(req, res) {
  let apply;
  try {
    apply = createPayoutCallback({
      withdrawals: Withdrawal,
      agentCode: process.env.RAMEE_GLOBAL_LKR_AGENT_CODE,
      accessKey: process.env.RAMEE_GLOBAL_LKR_ACCESS_KEY,
    });
  } catch { return unavailable(res); }
  try {
    const status = await apply(req.body);
    return res.status(status).json({ success: status === 200 });
  } catch {
    return res.status(503).json({ success: false, message: "LKR payout callback requires reconciliation." });
  }
}

function requireSupportedWithdrawalCurrency(req, res, next) {
  if (typeof req.body?.currency === "string" && req.body.currency.trim().toUpperCase() === "LKR") {
    return res.status(503).json({ success: false, message: "LKR withdrawals are unavailable." });
  }
  return next();
}

module.exports = { createDeposit, depositCallback, refreshDeposit, payoutCallback, payoutMethods, requireSupportedWithdrawalCurrency };
