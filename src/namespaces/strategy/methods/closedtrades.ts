// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LuxAlgo

import { Trade } from '../types';
import { tradeCostBasis } from '../utils';

/**
 * TradingView keeps only the last 9,000 closed trades listed: `first_index` = closedtrades − 9,000
 * (BINANCE:BTCUSDT 1h, 19,990 closed trades → 10,990), and a trade below it reads as out of range.
 * The counts and the aggregates still cover every trade.
 */
const LISTED_CLOSED_TRADES = 9000;

/**
 * Pine's `strategy.closedtrades` serves a dual role:
 *   - As a scalar: a series int count of closed trades.
 *   - As a namespace: `strategy.closedtrades.profit(idx)` etc.
 *
 * Our transpiler renders the bare access as a CALL (`strategy.closedtrades()`),
 * and the chained access as a CHAINED CALL (`strategy.closedtrades().profit(0)`).
 * Both must work. The trick: the call returns a hybrid object that:
 *   - has `valueOf()` returning the count (so it behaves like an int in
 *     arithmetic/comparison contexts, e.g. `_ct > 0`),
 *   - has the per-trade methods (`profit`, `size`, ...) attached.
 *
 * This pattern keeps the transpiler unchanged while supporting both shapes.
 */
export function closedtrades(context: any) {
    return () => {
        // SNAPSHOT the closed-trades list AT CALL TIME. When the returned
        // hybrid object is stored as a per-bar plot value, its valueOf /
        // method calls must reflect the state at the bar where it was
        // produced, NOT the live (final-bar) state — otherwise every
        // historical plot point collapses to the final-bar count.
        // The list is append-only (a streaming rollback only truncates it),
        // so its length at call time is the snapshot.
        const list: Trade[] = context.strategy?.closedtrades ?? [];
        const count = list.length;
        const firstIndex = Math.max(0, count - LISTED_CLOSED_TRADES);
        // `na` reads trade 0, as on TradingView.
        const at = (i: any): Trade | undefined => {
            let n = Number(i);
            if (Number.isNaN(n)) n = 0;
            return n >= firstIndex && n < count ? list[n] : undefined;
        };

        const result: any = {
            // Scalar for consumers that store or plot the value (Series.from, $.param).
            __value: count,
            valueOf() { return count; },
            toString() { return String(count); },
            [Symbol.toPrimitive]() { return count; },
        };

        const pointValue: number = context.pine?.syminfo?.pointvalue ?? 1;
        const costBasis = (t: Trade): number => tradeCostBasis(t, pointValue);

        // Out of range: 0 for the numeric getters, na for prices, bar indexes and times, as on
        // TradingView (like max_runup / max_drawdown below).
        result.profit = (i: any) => at(i)?.profit ?? 0;
        // The basis is signed: negative prices (back-adjusted futures) give a negative basis, which
        // TradingView divides by (CL1! 1D: 2,270 on −31.11 × 1 × 1,000 → −7.2967 %).
        result.profit_percent = (i: any) => {
            const t = at(i);
            if (!t) return 0;
            if (t.profit === undefined) return NaN;
            const basis = costBasis(t);
            return basis !== 0 ? (100 * t.profit) / basis : NaN;
        };
        result.size = (i: any) => at(i)?.size ?? 0;
        result.commission = (i: any) => at(i)?.commission ?? 0;
        result.entry_price = (i: any) => at(i)?.entry_price ?? NaN;
        result.entry_bar_index = (i: any) => at(i)?.entry_bar_index ?? NaN;
        result.entry_id = (i: any) => at(i)?.entry_id ?? '';
        // TV semantic: when no explicit comment was passed to strategy.entry,
        // entry_comment falls back to entry_id (and same for exit_comment ←
        // exit_id). openTrade already pre-stamps entry_id as entry_comment
        // when none is given, but keep the fallback defensive.
        result.entry_comment = (i: any) => at(i)?.entry_comment ?? at(i)?.entry_id ?? '';
        result.entry_time = (i: any) => at(i)?.entry_time ?? NaN;
        result.exit_price = (i: any) => at(i)?.exit_price ?? NaN;
        result.exit_bar_index = (i: any) => at(i)?.exit_bar_index ?? NaN;
        result.exit_id = (i: any) => at(i)?.exit_id ?? '';
        result.exit_comment = (i: any) => at(i)?.exit_comment ?? at(i)?.exit_id ?? '';
        result.exit_time = (i: any) => at(i)?.exit_time ?? NaN;
        result.max_drawdown = (i: any) => at(i)?.max_drawdown ?? 0;
        result.max_drawdown_percent = (i: any) => {
            const t = at(i);
            if (!t || !t.max_drawdown) return 0;
            const basis = costBasis(t);
            return basis > 0 ? (100 * t.max_drawdown) / basis : 0;
        };
        result.max_runup = (i: any) => at(i)?.max_runup ?? 0;
        result.max_runup_percent = (i: any) => {
            const t = at(i);
            if (!t || !t.max_runup) return 0;
            const basis = costBasis(t);
            return basis > 0 ? (100 * t.max_runup) / basis : 0;
        };
        // v6 property: index of the oldest still-listed trade.
        result.first_index = firstIndex;

        return result;
    };
}
