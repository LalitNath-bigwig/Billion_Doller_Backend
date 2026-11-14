const User = require("../models/User");
const Account = require("../models/account.model");
const IB = require("../models/Broker.model");
const Order = require("../models/Order");
const Withdrawal = require("../models/withdrawal");
const Ticket = require("../models/Ticket");
const Enquiry = require("../models/Enquiry");
const AuditLog = require("../models/AuditLog");
const { isEnabled: veriffEnabled } = require("../services/veriff.service");

const residence = { $ifNull: ["$residenceCountry", { $ifNull: ["$nationality", "Unspecified"] }] };
const registrationCountry = { $cond: [{ $eq: [residence, ""] }, "Unspecified", residence] };
const contactFields = "_id fullName email";
const eligibleRegistration = { isVerified: true };

function dubaiDateRange(from, to = from, now = new Date()) {
  const today = new Date(now.getTime() + 4 * 3600000).toISOString().slice(0, 10);
  from ||= today; to ||= from;
  for (const value of [from, to]) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error("Choose valid report dates.");
  }
  const start = new Date(`${from}T00:00:00+04:00`);
  const end = new Date(new Date(`${to}T00:00:00+04:00`).getTime() + 86400000);
  if (end <= start || end - start > 366 * 86400000) throw new Error("Choose a date range of up to 366 days, with the end after the start.");
  return { from, to, start, end, timezone: "Asia/Dubai" };
}

function createController({ users = User, accounts = Account, ibs = IB, orders = Order, withdrawals = Withdrawal, tickets = Ticket, enquiries = Enquiry, logs = AuditLog, now = () => new Date() } = {}) {
  const client = row => ({ clientId: row?._id, name: row?.fullName, email: row?.email });
  const definitions = {
    client: { model: users, permission: "clients", fields: `${contactFields} residenceCountry nationality isKycVerified`, format: row => ({ ...client(row), detail: row.residenceCountry ?? row.nationality, status: row.isKycVerified ? "KYC approved" : "KYC pending" }) },
    bank: { model: users, permission: "finance", fields: `${contactFields} bankApprovalStatus`, format: row => ({ ...client(row), status: row.bankApprovalStatus }) },
    account: { model: accounts, permission: "finance", fields: "user accountNo currency", populate: { path: "user", select: contactFields }, format: row => ({ ...client(row.user), reference: String(row.accountNo), detail: row.currency, status: "Live" }) },
    ib: { model: ibs, permission: "partners", fields: "user email referralCode status", populate: { path: "user", select: contactFields }, format: row => ({ ...client(row.user), email: row.user?.email || row.email, reference: row.referralCode, status: row.status }) },
    enquiry: { model: enquiries, permission: "enquiries", fields: "reference name email message status", format: row => ({ reference: row.reference, name: row.name, email: row.email, detail: row.message, status: row.status }) },
    ticket: { model: tickets, permission: "support", fields: "user subject description status", populate: { path: "user", select: contactFields }, format: row => ({ ...client(row.user), reference: row.subject, detail: row.description, status: row.status }) },
    deposit: { model: orders, permission: "finance", fields: "account orderid accountNo status", populate: { path: "account", select: "user", populate: { path: "user", select: contactFields } }, format: row => ({ ...client(row.account?.user), reference: row.orderid, detail: `MT5 ${row.accountNo}`, status: row.status }) },
    payout: { model: withdrawals, permission: "finance", fields: "userId name orderid accountNo status", populate: { path: "userId", select: contactFields }, format: row => ({ ...client(row.userId), name: row.userId?.fullName || row.name, reference: row.orderid, detail: `MT5 ${row.accountNo}`, status: row.status }) },
  };
  const queue = {
    pendingKyc: ["client", { ...eligibleRegistration, isKycVerified: false }],
    pendingIb: ["ib", { status: "pending" }],
    pendingBank: ["bank", { bankApprovalStatus: "pending" }],
    pendingPayouts: ["payout", { status: { $in: ["Pending", "Processing"] } }],
    openTickets: ["ticket", { status: { $in: ["Open", "Pending"] } }],
    newEnquiries: ["enquiry", { status: "new" }],
  };
  const period = {
    registrations: ["client", eligibleRegistration], newTradingAccounts: ["account", { accountType: "LIVE" }],
    ibApplications: ["ib", {}], newEnquiries: ["enquiry", {}], newTickets: ["ticket", {}],
  };
  const count = ([type, filter], extra) => definitions[type].model.countDocuments({ ...filter, ...extra });
  const queues = async () => Object.fromEntries(await Promise.all(Object.entries(queue).map(async ([key, filter]) => [key, await count(filter)])));
  return {
    async onboarding(req, res, next) {
      try {
        const user = await users.findById(req.principal.id).select("isVerified isKycVerified veriff.status kycProvider +kycManualReview").lean();
        if (!user) return res.status(404).json({ message: "Account not found." });
        const ownAccounts = await accounts.find({ user: req.principal.id, accountType: "LIVE" }).select("_id accountNo").lean();
        const accountNumbers = ownAccounts.map(account => String(account.accountNo));
        const [deposit, ib] = await Promise.all([
          ownAccounts.length ? orders.exists({ $or: [{ account: { $in: ownAccounts.map(account => account._id) } }, { accountNo: { $in: accountNumbers } }], status: "SUCCESS" }) : null,
          ibs.findOne({ email: req.principal.email }).select("status").lean(),
        ]);
        const provider = veriffEnabled() ? user.kycProvider : "manual";
        res.json({ emailVerified: !!user.isVerified, identityVerified: !!user.isKycVerified, identityStatus: user.isKycVerified ? "approved" : user.kycManualReview?.approved === false ? "manual_rejected" : (provider === "veriff" ? user.veriff?.status : null) || "not_started", identityProvider: provider, tradingAccountCreated: ownAccounts.length > 0, firstDepositCompleted: !!deposit, ibStatus: ib?.status || "not_applied" });
      } catch (error) { next(error); }
    },
    async overview(_req, res, next) { try { res.json({ generatedAt: now(), queues: await queues() }); } catch (error) { next(error); } },
    async report(req, res, next) {
      try {
        let range;
        try { range = dubaiDateRange(req.query.from || req.query.date, req.query.to, now()); } catch (error) { return res.status(400).json({ message: error.message }); }
        const createdAt = { $gte: range.start, $lt: range.end };
        const [registrations, newTradingAccounts, ibApplications, newEnquiries, newTickets, depositOrders, payoutRequests, countries, currentQueues] = await Promise.all([
          ...Object.values(period).map(filter => count(filter, { createdAt })),
          orders.aggregate([{ $match: { createdAt } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
          withdrawals.aggregate([{ $match: { createdAt } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
          users.aggregate([{ $match: { createdAt, ...eligibleRegistration } }, { $group: { _id: registrationCountry, count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 30 }]), queues(),
        ]);
        res.json({ generatedAt: now(), period: { from: range.from, to: range.to, timezone: range.timezone, start: range.start, endExclusive: range.end },
          registrations, newTradingAccounts, ibApplications, newEnquiries, newTickets,
          depositOrders: depositOrders.map(row => ({ status: row._id, count: row.count })), payoutRequests: payoutRequests.map(row => ({ status: row._id, count: row.count })),
          countries: countries.map(row => ({ country: row._id || "Unspecified", count: row.count })), queues: currentQueues,
          note: "Period totals count records created during the selected Dubai dates. Payment statuses reflect their current state. Work queues are a current snapshot. Country values are self-reported. Monetary totals are excluded because payment currencies differ." });
      } catch (error) { next(error); }
    },
    async reportDetails(req, res, next) {
      try {
        const { group, metric, value, from, to } = req.query;
        if (typeof metric !== "string") return res.status(400).json({ message: "Choose a valid report metric." });
        let selection;
        if (group === "queue" && Object.hasOwn(queue, metric)) selection = queue[metric];
        if (group === "period" && Object.hasOwn(period, metric)) selection = period[metric];
        if (group === "period" && [undefined, "string"].includes(typeof value) && (value?.length ?? 0) <= 100) {
          if (metric === "depositOrders") selection = ["deposit", { status: value ?? null }];
          if (metric === "payoutRequests") selection = ["payout", { status: value ?? null }];
          if (metric === "countries" && value) selection = ["client", { ...eligibleRegistration, $expr: { $eq: [registrationCountry, { $literal: value }] } }];
        }
        if (!selection) return res.status(400).json({ message: "Choose a valid report metric." });

        const [type, filters] = selection;
        const definition = definitions[type];
        if (req.principal.adminRole !== "owner" && !req.principal.permissions?.includes(definition.permission)) {
          return res.status(403).json({ message: "Your administrator account cannot view details for this category." });
        }
        const filter = { ...filters };
        if (group === "period") {
          let range;
          try { range = dubaiDateRange(from, to, now()); } catch (error) { return res.status(400).json({ message: error.message }); }
          filter.createdAt = { $gte: range.start, $lt: range.end };
        }
        const page = Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1));
        const limit = 25;
        let query = definition.model.find(filter).select(definition.fields + " createdAt")
          .sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit);
        if (definition.populate) query = query.populate(definition.populate);
        const [rows, total] = await Promise.all([query.lean(), definition.model.countDocuments(filter)]);
        const canOpenClients = req.principal.adminRole === "owner" || req.principal.permissions?.includes("clients");
        const accountNumbers = [...new Set(rows.filter(row => (type === "deposit" && !row.account?.user) || (type === "payout" && !row.userId))
          .map(row => Number(row.accountNo)).filter(value => Number.isSafeInteger(value) && value > 0))];
        const legacyAccounts = accountNumbers.length ? await accounts.find({ accountNo: { $in: accountNumbers } }).select("accountNo user")
          .populate({ path: "user", select: contactFields }).lean() : [];
        const accountContacts = new Map(legacyAccounts.map(row => [row.accountNo, client(row.user)]));
        const data = rows.map(row => {
          const record = definition.format(row);
          if (type === "client" && group === "period") record.status = "Registration verified";
          const legacyContact = ["deposit", "payout"].includes(type) && !record.clientId ? accountContacts.get(Number(row.accountNo)) : undefined;
          const { clientId, ...display } = legacyContact ? { ...record, ...legacyContact } : record;
          return { id: row._id, createdAt: row.createdAt, ...display, ...(canOpenClients && { clientId }) };
        });
        return res.json({ data, total, page, pages: Math.ceil(total / limit) });
      } catch (error) { next(error); }
    },
    async audit(req, res, next) {
      try {
        const page = Math.max(1, Math.min(100000, parseInt(req.query.page, 10) || 1)), limit = 50;
        const [data, total] = await Promise.all([logs.find({}).sort({ occurredAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), logs.countDocuments({})]);
        res.json({ data, total, page, pages: Math.ceil(total / limit) });
      } catch (error) { next(error); }
    },
  };
}
module.exports = { createController, dubaiDateRange };
