// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LuxAlgo

import { tradeCostBasis } from '../utils';

/**
 * Average return of the losing closed trades as a percent: the mean of their
 * strategy.closedtrades.profit_percent. NaN when no losers yet.
 */
export function avg_losing_trade_percent(context: any) {
    return () => {
        const s = context.strategy;
        if (!s || s.losstrades === 0) return NaN;
        const pointValue = context.pine?.syminfo?.pointvalue ?? 1;
        let sum = 0;
        for (const t of s.closedtrades) {
            if ((t.profit ?? 0) < 0) {
                const basis = tradeCostBasis(t, pointValue);
                if (basis !== 0) sum += (100 * (t.profit ?? 0)) / basis;
            }
        }
        return sum / s.losstrades;
    };
}
