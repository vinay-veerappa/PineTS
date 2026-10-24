// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LuxAlgo

/**
 * Average loss of the losing closed trades, as a POSITIVE number. TradingView
 * reports strategy.grossloss / strategy.losstrades (grossloss then includes the
 * entry commission of a trade still open). NaN when no losers yet.
 */
export function avg_losing_trade(context: any) {
    return () => {
        const s = context.strategy;
        if (!s || s.losstrades === 0) return NaN;
        return s.grossloss / s.losstrades;
    };
}
