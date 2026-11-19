const Account = require("../../models/account.model");
const Order = require("../../models/Order");
const { balanceWithClaim, runDeposit } = require("../../services/depositCredit.service");
const { createIdrDepositService, idrClient, maxAmountIdr } = require("../../services/rameeGlobalIdrDeposit.service");
const { readLkrMinor } = require("../../utils/rameeGlobalProtocol");

const unavailable = res => res.status(503).json({ success: false, message: "IDR payments are unavailable." });

function build(scope) {
  let client;
  try { client = idrClient(); } catch (error) {
    console.error(`[RameeGlobalIDR] ${scope}: config invalid: ${error.message}`);
    return null;
  }
  if (!client) {
    console.error(`[RameeGlobalIDR] ${scope}: disabled, RAMEE_GLOBAL_IDR_ENABLED is not exactly "true"`);
    return null;
  }
  return {
    client,
    service: createIdrDepositService({ client, orders: Order, balanceWithClaim, runDeposit, maxAmountIdr: maxAmountIdr() }),
  };
}

// POST /api/payment/ramee-global/idr/deposit  { accountNo, amount }  (whole rupiah)
async function createDeposit(req, res) {
  const built = build("createDeposit");
  if (!built) return unavailable(res);

  let idrMinorPerUsd;
  try {
    idrMinorPerUsd = readLkrMinor(process.env.RAMEE_GLOBAL_IDR_PER_USD, 9);
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
  const account = await Account.findOne({ accountNo: Number(req.body.accountNo) }).select("_id accountNo");
  if (!account) return res.status(404).json({ success: false, message: "Account not found." });

  try {
    const order = await built.service.createDeposit({ account, amountIdr, idrMinorPerUsd });
    return res.status(201).json({ success: true, ...order });
  } catch (error) {
    if (error instanceof RangeError) return res.status(400).json({ success: false, message: error.message });
    console.error(`[RameeGlobalIDR] createDeposit: checkout failed for account ${account.accountNo}: ${error.message}`);
    return res.status(502).json({ success: false, message: "IDR checkout could not be confirmed." });
  }
}

// RameeGlobalPay sends every currency to one webhook URL. This handler only
// takes IDR pay-in events and otherwise calls next() so the LKR handler runs.
async function depositCallback(req, res, next) {
  let built;
  try { built = idrClient() ? build("depositCallback") : null; } catch { built = null; }
  if (!built) return next(); // IDR off or misconfigured: leave it to the LKR handler.
  let event;
  try { event = built.client.decodeDepositCallback(req.body); } catch { return next(); }
  try {
    const status = await built.service.applyCallback(event);
    if (!status) return res.status(404).json({ success: false, message: "IDR deposit not found." });
    return res.json({ success: true });
  } catch (error) {
    console.error(`[RameeGlobalIDR] depositCallback: ${error.message}`);
    return res.status(503).json({ success: false, message: "IDR deposit requires reconciliation." });
  }
}

async function refreshDeposit(req, res) {
  const built = build("refreshDeposit");
  if (!built) return unavailable(res);
  try {
    const status = await built.service.refresh(req.params.orderid);
    if (!status) return res.status(404).json({ success: false, message: "IDR deposit not found." });
    return res.json({ success: true, status });
  } catch (error) {
    console.error(`[RameeGlobalIDR] refreshDeposit: ${error.message}`);
    return res.status(503).json({ success: false, message: "IDR deposit requires reconciliation." });
  }
}

module.exports = { createDeposit, depositCallback, refreshDeposit };
