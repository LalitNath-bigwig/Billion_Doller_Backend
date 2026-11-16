const { randomUUID } = require("node:crypto");

// Standalone simulator. It uses one fictional wallet and never connects to the BDFX API,
// MT5, a database, or a payment provider. Amounts are integers in currency minor units.
function createLkrSandbox({ lkrMinorPerUsd, openingUsdCents = 0 }) {
  if (!Number.isSafeInteger(lkrMinorPerUsd) || lkrMinorPerUsd <= 0 ||
      !Number.isSafeInteger(openingUsdCents) || openingUsdCents < 0) {
    throw new Error("Use a positive test exchange rate and a non-negative starting balance.");
  }

  const orders = new Map();
  let available = BigInt(openingUsdCents);
  let reserved = 0n;

  function createOrder(direction, amountLkrMinor) {
    if (!Number.isSafeInteger(amountLkrMinor) || amountLkrMinor <= 0) {
      throw new Error("Enter a positive LKR amount in minor units.");
    }
    const scaled = BigInt(amountLkrMinor) * 100n;
    const rate = BigInt(lkrMinorPerUsd);
    // Round a deposit credit down and a withdrawal reserve up to the nearest cent.
    const usdCents = direction === "deposit" ? scaled / rate : (scaled + rate - 1n) / rate;
    if (usdCents === 0n) throw new Error("Amount is below one USD cent at the simulated rate.");
    if (direction === "withdrawal") {
      if (usdCents > available) throw new Error("Insufficient simulated balance.");
      available -= usdCents;
      reserved += usdCents;
    }
    const order = {
      id: randomUUID().replace(/-/g, ""),
      direction,
      currency: "LKR",
      amountLkrMinor,
      usdCents,
      lkrMinorPerUsd,
      status: direction === "deposit" ? "awaiting_payment" : "awaiting_approval",
    };
    orders.set(order.id, order);
    return { ...order };
  }

  function resolveWithdrawal(id, decision) {
    const order = orders.get(id);
    if (order?.direction !== "withdrawal" || order.status !== "awaiting_approval") {
      throw new Error("Withdrawal is not awaiting approval.");
    }
    if (decision === "approve") {
      order.status = "processing";
    } else if (decision === "reject") {
      order.status = "rejected";
      reserved -= order.usdCents;
      available += order.usdCents;
    } else {
      throw new Error("Enter approve or reject.");
    }
    return { ...order };
  }

  function simulateCallback({ id, direction, currency, amountLkrMinor, status }) {
    const order = orders.get(id);
    if (!order || order.direction !== direction || order.currency !== currency || order.amountLkrMinor !== amountLkrMinor) {
      throw new Error("Callback does not match the simulated order.");
    }
    if (!["pending", "succeeded", "failed"].includes(status)) throw new Error("Unknown simulated callback status.");

    const awaiting = direction === "deposit" ? "awaiting_payment" : "processing";
    if (order.status === "awaiting_approval") throw new Error("Approve the withdrawal before simulating a callback.");
    if (order.status !== awaiting) {
      if (status !== "pending" && status !== order.status) throw new Error("Conflicting final status. Reconcile before applying another balance change.");
      return { ...order };
    }
    // A pending or uncertain gateway response has no balance effect. For payouts,
    // keep the reserve until a final outcome is confirmed.
    if (status === "pending") return { ...order };
    if (direction === "deposit" && status === "succeeded") available += order.usdCents;
    if (direction === "withdrawal") {
      reserved -= order.usdCents;
      if (status === "failed") available += order.usdCents;
    }
    order.status = status;
    return { ...order };
  }

  return { createDeposit: amount => createOrder("deposit", amount),
    requestWithdrawal: amount => createOrder("withdrawal", amount), resolveWithdrawal, simulateCallback,
    getOrder(id) {
      const order = orders.get(id);
      return order ? { ...order } : null;
    },
    balance: () => ({ availableUsdCents: available, reservedUsdCents: reserved }) };
}

if (require.main === module) {
  const demo = createLkrSandbox({ lkrMinorPerUsd: 30000 }); // Fictional rate for repeatable output.
  const deposit = demo.createDeposit(3000000);
  demo.simulateCallback({ ...deposit, status: "succeeded" });
  const withdrawal = demo.requestWithdrawal(600000);
  demo.resolveWithdrawal(withdrawal.id, "approve");
  const payout = demo.simulateCallback({ ...withdrawal, status: "succeeded" });
  console.log("Simulated deposit and payout completed.", { depositUsdCents: deposit.usdCents, payoutUsdCents: payout.usdCents, ...demo.balance() });
}

module.exports = { createLkrSandbox };
