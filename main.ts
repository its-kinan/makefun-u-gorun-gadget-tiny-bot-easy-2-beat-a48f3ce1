// Tiny trend bot — beat buy-and-hold on Solana hourly bars.
//
// Strategy: per symbol, hold only while its fast EMA (8 bars) sits above its
// slow EMA (20 bars). That keeps the bot in cash through the broad slides
// where buy-and-hold bleeds, and invested while an uptrend runs. Holdings
// are equal-weighted among the trending symbols, capped at 25% of equity
// each, and rebalanced only when a holding drifts more than 1% of equity
// away from its target, so fees stay small. Exits are sells at market;
// there are no shorts and no leverage.
//
// Protocol: agent-fun/bars-replay/v1, newline-delimited JSON on stdin/stdout.
// The bot answers every batch with one reply echoing the batch seq. Orders
// decided on a batch fill at the next bar's open, so all sizing uses the
// latest close and the account snapshot the harness sends with the batch.
//
// Deterministic: no network, no clock, no randomness. Same input bytes in,
// same orders out, every run.

import * as readline from "node:readline";

// --- strategy constants -------------------------------------------------
const FAST_LEN = 12;
const SLOW_LEN = 30;
const CONFIRM_BARS = 2; // enter only after the cross has held this long;
// exits stay immediate, so a broken trend is never ridden down.
const MAX_WEIGHT_BPS = 2000; // 20% of equity per symbol. With all seven
// symbols trending the equal weight (1/7) binds first, so a broad rally
// is still fully invested like buy-and-hold; the cap only trims
// concentrated bets when one or two names trend alone.
const DEADBAND_BPS = 100; // 1% of equity: ignore smaller drifts
const BUY_HAIRCUT = 0.95; // size buys 5% light: fills happen at the next
// open, not this close, so a fill a little dearer than the close must
// never leave the batch short of cash and get the later buys rejected.
const MAX_SLIPPAGE_BPS = 10000; // wide open, like the house baseline
const MIN_NOTIONAL_USDC = 1; // harness minimum, in whole USDC

// --- per-symbol market state --------------------------------------------
type SymbolState = {
  priceScale: number;
  qtyScale: number;
  closesSeen: number;
  emaFast: number;
  emaSlow: number;
  lastClose: number; // USDC per token, float
  crossStreak: number; // consecutive bars with fast EMA above slow EMA
};

const symbols = new Map<string, SymbolState>();
let warmupBars = 0;
let batchesSeen = 0;
let quoteScale = 6;

function emaUpdate(prev: number, price: number, len: number): number {
  const k = 2 / (len + 1);
  return price * k + prev * (1 - k);
}

function priceFromRaw(raw: string, scale: number): number {
  return Number(raw) / 10 ** scale;
}

// --- order building ------------------------------------------------------
// All money math in whole USDC floats for sizing; the wire format wants
// integer strings, so conversions floor to the integer unit at the end.
function buildOrders(msg: any): any[] {
  batchesSeen += 1;
  const orders: any[] = [];
  if (batchesSeen <= warmupBars) return orders;

  // Fold this batch's bars into the EMAs.
  for (const bar of msg.bars ?? []) {
    const st = symbols.get(bar.symbol);
    if (!st) continue;
    const close = priceFromRaw(bar.c, st.priceScale);
    st.lastClose = close;
    st.closesSeen += 1;
    if (st.closesSeen === 1) {
      st.emaFast = close;
      st.emaSlow = close;
    } else {
      st.emaFast = emaUpdate(st.emaFast, close, FAST_LEN);
      st.emaSlow = emaUpdate(st.emaSlow, close, SLOW_LEN);
    }
    st.crossStreak = st.emaFast > st.emaSlow ? st.crossStreak + 1 : 0;
  }
  if (batchesSeen < SLOW_LEN) return orders;

  const account = msg.account;
  const equityUsdc = Number(account.equity_quote_units) / 10 ** quoteScale;
  const cashUsdc = Number(account.cash_quote_units) / 10 ** quoteScale;
  if (equityUsdc <= 0) return orders;
  const deadbandUsdc = (equityUsdc * DEADBAND_BPS) / 10000;

  // Trending symbols, in universe order: fast above slow, confirmed.
  const longs: string[] = [];
  for (const [symbol, st] of symbols) {
    if (st.closesSeen >= SLOW_LEN && st.crossStreak >= CONFIRM_BARS) {
      longs.push(symbol);
    }
  }
  const weight =
    longs.length === 0
      ? 0
      : Math.min(MAX_WEIGHT_BPS / 10000, 1 / longs.length);
  const longSet = new Set(longs);

  // Current holdings, valued at the latest close.
  const heldQty = new Map<string, bigint>();
  for (const pos of account.positions ?? []) {
    heldQty.set(pos.symbol, BigInt(pos.qty));
  }
  const heldValue = new Map<string, number>();
  for (const [symbol, st] of symbols) {
    const qty = heldQty.get(symbol) ?? 0n;
    if (qty > 0n && st.lastClose > 0) {
      heldValue.set(symbol, Number(qty) / 10 ** st.qtyScale * st.lastClose);
    } else {
      heldValue.set(symbol, 0);
    }
  }

  // Sells first, so their proceeds fund the buys in the same batch.
  let cashLeft = cashUsdc;
  for (const [symbol, st] of symbols) {
    const target = longSet.has(symbol) ? weight * equityUsdc : 0;
    const current = heldValue.get(symbol) ?? 0;
    if (current <= target + deadbandUsdc) continue;
    const qtyHeld = heldQty.get(symbol) ?? 0n;
    if (qtyHeld <= 0n || st.lastClose <= 0) continue;
    const sellUsdc = Math.min(current - target, current);
    let qtyRaw = BigInt(
      Math.floor((sellUsdc / st.lastClose) * 10 ** st.qtyScale),
    );
    if (qtyRaw > qtyHeld) qtyRaw = qtyHeld;
    if (qtyRaw <= 0n) continue;
    cashLeft += Number(qtyRaw) / 10 ** st.qtyScale * st.lastClose;
    orders.push({
      side: "sell",
      client_id: `s${msg.seq}-${symbol}`,
      symbol,
      qty: qtyRaw.toString(),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
  }

  // Buys, capped by the cash on hand after the sells above.
  for (const symbol of longs) {
    const st = symbols.get(symbol)!;
    const target = weight * equityUsdc;
    const current = heldValue.get(symbol) ?? 0;
    if (target - current <= deadbandUsdc) continue;
    let spend = Math.min(target - current, cashLeft) * BUY_HAIRCUT;
    if (spend < MIN_NOTIONAL_USDC) continue;
    cashLeft -= spend;
    const notional = Math.floor(spend * 10 ** quoteScale);
    if (notional <= 0) continue;
    orders.push({
      side: "buy",
      client_id: `b${msg.seq}-${symbol}`,
      symbol,
      notional_quote_units: String(notional),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
  }
  return orders;
}

// --- main loop ------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.type === "hello") {
    quoteScale = msg.capital.quote_scale;
    warmupBars = msg.warmup_bars ?? 0;
    for (const s of msg.symbols) {
      symbols.set(s.symbol, {
        priceScale: s.price_scale,
        qtyScale: s.qty_scale,
        closesSeen: 0,
        emaFast: 0,
        emaSlow: 0,
        lastClose: 0,
        crossStreak: 0,
      });
    }
  } else if (msg.type === "batch") {
    const orders = buildOrders(msg);
    process.stdout.write(
      JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n",
    );
  } else if (msg.type === "done") {
    process.exit(0);
  }
}
