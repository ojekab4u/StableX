import { getPool } from "../db/pool.js";
import { listNdaxTrades, listNdaxWithdrawals, listNdaxDeposits } from "./providers/ndaxService.js";

// Every movement on the shared Ndax account, labelled with its source:
//   STABLEX_CASH_OUT / STABLEX_FUND — placed by this backend, linked to the
//     customer record that produced it (client order id -> order id).
//   STABLEX_UNLINKED — a StableX client order id with no database record
//     (investigate).
//   DASHBOARD — client order id 0: a human did it in the Ndax web console.
//   DEPOSIT / provider name — money arriving from outside.
export async function getNdaxAudit() {
  const [trades, withdrawals, deposits] = await Promise.all([
    listNdaxTrades(), listNdaxWithdrawals(), listNdaxDeposits(),
  ]);

  const links = new Map();
  const cashOuts = await getPool().query(
    `SELECT cash_out_id, customer_id, order_id, state, amount::text AS amount
     FROM cash_outs WHERE order_id IS NOT NULL`
  );
  for (const row of cashOuts.rows) {
    links.set(String(row.order_id), {
      kind: "CASH_OUT", customerId: row.customer_id, state: row.state, refId: row.cash_out_id, amount: Number(row.amount),
    });
  }
  const fundings = await getPool().query(
    `SELECT funding_id, customer_id, order_id, state, credited_amount::text AS credited
     FROM wallet_fundings WHERE order_id IS NOT NULL`
  );
  for (const row of fundings.rows) {
    links.set(String(row.order_id), {
      kind: "FUND", customerId: row.customer_id, state: row.state, refId: row.funding_id,
      amount: row.credited === null ? null : Number(row.credited),
    });
  }

  const events = [];
  for (const t of trades) {
    const link = links.get(String(t.orderId));
    events.push({
      at: t.tradeTime,
      type: `TRADE ${t.side || ""}`.trim(),
      source: link ? `STABLEX_${link.kind}` : (t.clientOrderId ? "STABLEX_UNLINKED" : "DASHBOARD"),
      customerId: link?.customerId ?? null,
      detail: `${t.symbol || ""} ${t.quantity} @ ${t.price} (fee ${t.fee})`,
      refId: t.tradeId,
      orderId: t.orderId,
      clientOrderId: t.clientOrderId,
      state: null,
    });
  }
  for (const w of withdrawals) {
    events.push({
      at: w.createdTimestamp,
      type: "WITHDRAWAL",
      source: w.platform === "WEB" ? "DASHBOARD" : (w.platform || "UNKNOWN"),
      customerId: null,
      detail: `${w.currency || "?"} ${w.amount} → ${w.externalAddress || "?"}${w.fee ? ` (fee ${w.fee})` : ""}`,
      refId: w.withdrawId,
      orderId: null,
      clientOrderId: null,
      state: w.status,
    });
  }
  for (const d of deposits) {
    events.push({
      at: null,
      type: "DEPOSIT",
      source: d.info?.AccountProviderName || "EXTERNAL",
      customerId: null,
      detail: `${d.currency || "?"} ${d.amount} tx ${d.info?.TxId || "—"}`,
      refId: d.depositId,
      orderId: null,
      clientOrderId: null,
      state: d.status,
    });
  }

  events.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  const unexplained = events.filter((e) => e.source === "STABLEX_UNLINKED");
  return {
    generatedAt: new Date().toISOString(),
    events,
    summary: {
      stablexCashOuts: events.filter((e) => e.source === "STABLEX_CASH_OUT").length,
      stablexFunds: events.filter((e) => e.source === "STABLEX_FUND").length,
      dashboard: events.filter((e) => e.source === "DASHBOARD").length,
      unexplained: unexplained.length,
    },
  };
}
