// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LuxAlgo

import { tradeCostBasis } from '../utils';

/**
 * Average per-trade return as a percent: the mean of each closed trade's
 * strategy.closedtrades.profit_percent (profit over entry notional plus the
 * trade's entry commission). NaN when no trades have closed.
 */
export function avg_trade_percent(context: any) {
    return () => {
        const s = context.strategy;
        if (!s || !s.closedtrades || s.closedtrades.length === 0) return NaN;
        const pointValue = context.pine?.syminfo?.pointvalue ?? 1;
        let sum = 0;
        for (const t of s.closedtrades) {
            const basis = tradeCostBasis(t, pointValue);
            if (basis !== 0) sum += (100 * (t.profit ?? 0)) / basis;
        }
        return sum / s.closedtrades.length;
    };
}
