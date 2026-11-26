const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const Order = require("../models/Order");
const Withdrawal = require("../models/withdrawal");
const { Alert, Cursor } = require("../models/PaymentAlert");

const TEN_MINUTES = 600000;
const durable = { writeConcern: { w: "majority" } };
const signal = new EventEmitter();
let watch, retryWatchAt = 0;
function listen() {
  if (watch || Date.now() < retryWatchAt) return;
  try {
    watch = Order.db.watch([{ $match: {
      "ns.coll": { $in: [Order.collection.name, Withdrawal.collection.name] },
      operationType: { $in: ["insert", "update", "replace"] },
    } }, { $project: { documentKey: 1 } }]);
    watch.on("change", () => signal.emit("payment"));
    const stream = watch;
    const reset = () => {
      if (watch !== stream) return;
      watch = null;
      retryWatchAt = Date.now() + 60000;
      void stream.close().catch(() => {});
    };
    stream.on("error", reset).on("close", reset);
  } catch { retryWatchAt = Date.now() + 60000; }
}
function waitForPayment(ms) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.off("payment", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.once("payment", done);
  });
}
const depositFilter = { $or: [{ status: "FAILED" }, { provider: "RAMEE", rameeDropAt: { $type: "date" } }] };
const payoutStatuses = ["Pending", "Processing", "Completed", "Failed", "Rejected"];
function amountFor(type, row) {
  if (type === "withdrawal") return [row.amount, row.currency === "CRYPTO" ? row.cryptoSymbol : row.currency];
  switch (row.provider) {
    case "RAMEE": return [row.amount, "INR"];
    case "CRYPTO": return [row.amount, "USDT"];
    case "RAMEE_GLOBAL_LKR": return [row.rameeGlobalLkr?.amountLkrMinor / 100, "LKR"];
    case "RAMEE_GLOBAL_IDR": return [row.rameeGlobalIdr?.amountIdr, "IDR"];
    case "FLOXY": return [row.floxy?.localAmount, "VND"];
    case "CREGIS": return [row.amount, "USD"];
    default: return [null, null];
  }
}
function classify(type, row, lastSentAt, now) {
  if (!row) return "closed";
  if (type === "withdrawal") {
    if (!payoutStatuses.includes(row.status)) return "defer";
    if (!lastSentAt) return "withdrawal_new";
    if (row.status !== "Pending") return "closed";
    return +now - +lastSentAt >= TEN_MINUTES ? "withdrawal_reminder" : "defer";
  }
  if (row.settlementAttempt?.state) return "defer";
  if (row.creditedAmount > 0 || row.lastSettlementTicket || ["SUCCESS", "PARTIALLY_PAID"].includes(row.status)) return "closed";
  if (row.status === "FAILED" || (row.provider === "RAMEE" && row.rameeDropAt && row.status === "PENDING")) return "deposit_drop";
  return "closed";
}
// All event discovery is replayable. The overlap also covers transactions that became visible after the last scan.
async function discover() {
  const to = new Date();
  const cursor = await Cursor.findOneAndUpdate({ _id: "payments" }, { $setOnInsert: { startedAt: to, through: to } },
    { new: true, upsert: true, ...durable }).lean();
  const from = new Date(Math.max(+cursor.startedAt, +cursor.through - TEN_MINUTES));
  for (const [type, model, field, filter] of [
    ["withdrawal", Withdrawal, "createdAt", {}], ["deposit", Order, "updatedAt", depositFilter],
  ]) {
    const stream = model.find({ ...filter, [field]: { $gte: from, $lte: to } }).select("_id").lean().cursor();
    const writes = [];
    const flush = async () => {
      if (!writes.length) return;
      try { await Alert.bulkWrite(writes.splice(0), { ordered: false, ...durable }); }
      catch (e) { if (!e.writeErrors?.length || !e.writeErrors.every(w => w.code === 11000) || e.writeConcernErrors?.length) throw e; }
    };
    for await (const row of stream) {
      writes.push({ updateOne: { filter: { _id: type + ":" + row._id },
        update: { $setOnInsert: { type, paymentId: row._id, dueAt: to } }, upsert: true } });
      if (writes.length === 100) await flush();
    }
    await flush();
  }
  await Cursor.updateOne({ _id: "payments" }, { $max: { through: to } }, durable);
}
async function due() {
  // An interrupted preparation can be retried. Once a send starts, only a receipt or explicit Telegram rejection releases it.
  await Alert.updateMany({ claim: { $exists: true }, dispatching: { $ne: true }, claimedAt: { $lt: new Date(Date.now() - 60000) } },
    { $unset: { claim: 1, claimedAt: 1 } }, durable);
  const rows = await Alert.find({ dueAt: { $lte: new Date() }, claim: { $exists: false } }).sort({ dueAt: 1, _id: 1 }).limit(16).select("_id").lean();
  return rows.map(row => ({ key: row._id }));
}
function validKey(key) { return typeof key === "string" && /^(deposit|withdrawal):[a-f0-9]{24}$/.test(key); }
async function prepare(_id) {
  if (!validKey(_id)) return null;
  const now = new Date(), claim = randomUUID();
  const job = await Alert.findOneAndUpdate({ _id, dueAt: { $lte: now }, claim: { $exists: false } },
    { $set: { claim, claimedAt: now } }, { new: true, ...durable }).lean();
  if (!job) return null;
  const key = { _id, claim };
  let item;
  try {
    const deposit = job.type === "deposit";
    const model = deposit ? Order : Withdrawal;
    const row = await model.findById(job.paymentId).select("orderid status amount currency cryptoSymbol provider accountNo createdAt creditedAmount lastSettlementTicket settlementAttempt.state rameeDropAt rameeGlobalLkr.amountLkrMinor rameeGlobalIdr.amountIdr floxy.localAmount").lean();
    let kind = classify(job.type, row, job.lastSentAt, now);
    if (kind === "deposit_drop") {
      // Recheck comparable subsequent attempts before warning that the deposit did not credit.
      const comparable = { accountNo: row.accountNo, provider: row.provider, amount: row.amount, _id: { $ne: row._id },
        createdAt: { $gte: row.createdAt, $lte: now } };
      for (const [provider, field, value] of [["FLOXY","floxy.localAmount",row.floxy?.localAmount],
        ["RAMEE_GLOBAL_LKR","rameeGlobalLkr.amountLkrMinor",row.rameeGlobalLkr?.amountLkrMinor],
        ["RAMEE_GLOBAL_IDR","rameeGlobalIdr.amountIdr",row.rameeGlobalIdr?.amountIdr]]) {
        if (row.provider === provider && value > 0) { delete comparable.amount; comparable[field] = value; }
      }
      if (await Order.exists({ ...comparable, $or: [{ status: { $in: ["SUCCESS", "PARTIALLY_PAID"] } }, { creditedAmount: { $gt: 0 } }] })) kind = "closed";
    }
    if (kind === "defer" || kind === "closed") {
      const update = { $unset: { claim: 1, claimedAt: 1 } };
      if (kind === "defer") update.$set = { dueAt: new Date(+now + 15000) };
      else update.$unset.dueAt = 1;
      await Alert.updateOne(key, update, durable);
      return null;
    }
    const [amount, currency] = amountFor(job.type, row);
    item = { source: "BDFX", kind, key: _id, claim, orderRef: row.orderid, amount, currency,
      status: deposit && row.status === "PENDING" ? "DROP" : row.status, requestedAt: row.createdAt, checkedAt: new Date(),
      previousAlertAt: job.lastSentAt, ...(deposit && { noCreditVerified: true, retryCredited: false }) };
  } catch (error) {
    await Alert.updateOne(key, { $unset: { claim: 1, claimedAt: 1 } }, durable);
    throw error;
  }
  return item;
}
async function poll(wait) {
  listen();
  await discover();
  let items = await due();
  if (wait && !items.length) {
    await waitForPayment(14500);
    await discover();
    items = await due();
  }
  return items;
}
async function begin({ key, claim } = {}) {
  if (!validKey(key) || typeof claim !== "string") return false;
  const job = await Alert.findOneAndUpdate({ _id: key, claim, dispatching: { $ne: true }, claimedAt: { $gt: new Date(Date.now() - 30000) } },
    { $set: { dispatching: true } }, { new: true, ...durable }).lean();
  if (!job) return false;
  if (job.type === "withdrawal" && job.lastSentAt) {
    try {
      if (await Withdrawal.exists({ _id: job.paymentId, status: "Pending" })) return true;
      await Alert.updateOne({ _id: key, claim }, { $unset: { dueAt: 1, claim: 1, claimedAt: 1, dispatching: 1 } }, durable);
      return false;
    } catch (error) {
      await Alert.updateOne({ _id: key, claim }, { $unset: { claim: 1, claimedAt: 1, dispatching: 1 } }, durable);
      throw error;
    }
  }
  return true;
}
async function receipt({ key, claim, messageId } = {}) {
  if (!/^(deposit|withdrawal):[a-f0-9]{24}$/.test(key || "") || !/^[a-f0-9-]{36}$/.test(claim || "") || !Number.isSafeInteger(messageId) || messageId <= 0) return 400;
  const lastSentAt = new Date();
  const changes = { $set: { lastSentAt, messageId }, $unset: { claim: 1, claimedAt: 1, dispatching: 1 } };
  if (key.startsWith("withdrawal:")) changes.$set.dueAt = new Date(+lastSentAt + TEN_MINUTES);
  else changes.$unset.dueAt = 1;
  const updated = await Alert.updateOne({ _id: key, claim, dispatching: true }, changes, durable);
  if (updated.matchedCount) return 200;
  return await Alert.exists({ _id: key, messageId }) ? 200 : 409;
}
async function releaseRejected({ key, claim, errorCode, retryAfter } = {}) {
  if (!validKey(key) || !/^[a-f0-9-]{36}$/.test(claim || "") || ![400,403,429].includes(errorCode)) return 400;
  const wait = Math.max(30, Math.min(86400, Number.isSafeInteger(retryAfter) ? retryAfter : 60));
  const changed = await Alert.updateOne({ _id: key, claim, dispatching: true }, {
    $unset: { claim: 1, claimedAt: 1, dispatching: 1 }, $set: { dueAt: new Date(Date.now() + wait * 1000) },
  }, durable);
  return changed.matchedCount ? 200 : 409;
}
module.exports = { poll, prepare, begin, receipt, releaseRejected, classify, amountFor };
