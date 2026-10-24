// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LuxAlgo

/**
 * Price at which the current position would be force-liquidated.
 * Returns NaN when flat, without a margin model, and for a long at 100% margin.
 *
 * Official TV formula, documented at
 * https://www.tradingview.com/support/solutions/43000717375/ :
 *
 *   MarginLiquidationPriceRaw =
 *       ((InitialCapital + NetProfit) / (PointValue * AbsPositionSize)
 *        − Direction * EntryPrice)
 *     / (MarginPercent / 100 − Direction)
 *
 * Where:
 *   InitialCapital + NetProfit = realized account equity (initial cash
 *                                 plus closed-trade P&L; excludes openprofit)
 *   PointValue                 = syminfo.pointvalue (1 for crypto, varies
 *                                 for futures contracts)
 *   AbsPositionSize            = |strategy.position_size|
 *   Direction                  = +1 for long, −1 for short
 *   EntryPrice                 = strategy.position_avg_price
 *   MarginPercent              = margin_long for longs, margin_short for shorts
 */
export function margin_liquidation_price(context: any) {
    return () => {
        const s = context.strategy;
        if (!s || s.position_size === 0) return NaN;
        const avgPrice = s.position_avg_price;
        if (!Number.isFinite(avgPrice)) return NaN;

        const direction = Math.sign(s.position_size);
        const marginPct = direction === 1
            ? (s.config.margin_long  ?? 100)
            : (s.config.margin_short ?? 100);
        // No margin model (margin 0, the v5 default): na. At exactly 100% a long has no liquidation
        // price (the denominator is 0), while a short still has one: TradingView reports
        // (equity / qty + entry) / 2 for 1 contract short at 62,867.99 with 101,166.93 realized
        // equity → 82,017.46. Above 100% a long has one again: 131,526.56 =
        // (10,000 / 0.07604 − 65,746.45) / 0.5 at margin_long = 150.
        if (!(marginPct > 0)) return NaN;
        if (direction === 1 && marginPct === 100) return NaN;

        const qty        = Math.abs(s.position_size);
        const pointValue = context.pine?.syminfo?.pointvalue ?? 1;
        const realizedEq = (s.initial_capital ?? 0) + (s.netprofit ?? 0);

        const numerator   = realizedEq / (pointValue * qty) - direction * avgPrice;
        const denominator = marginPct / 100 - direction;
        const raw         = numerator / denominator;

        // Per the TV docs, the raw value is rounded to the nearest mintick:
        // DOWN for longs (toward more negative, safer/farther from current),
        // UP for shorts (toward more positive, safer/farther from current).
        // The epsilon keeps float noise on an exact tick (…31.0000000001) from moving it a tick.
        const mintick = context.pine?.syminfo?.mintick ?? 0.01;
        const ticks = raw / mintick;
        return direction === 1
            ? Math.floor(ticks + 1e-6) * mintick
            : Math.ceil(ticks - 1e-6)  * mintick;
    };
}
