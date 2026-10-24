// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LuxAlgo

/**
 * strategy.openprofit_percent — open P&L as a percentage of realized equity (initial capital +
 * net profit), as the reference manual states and TradingView reports: 2,357.93 open profit on
 * 109,562.64 realized equity is 2.152%.
 */
export function openprofit_percent(context: any) {
    return () => {
        const s = context.strategy;
        if (!s) return 0;
        const realized = (s.initial_capital ?? 0) + (s.netprofit ?? 0);
        if (!realized) return 0;
        return (100 * s.openprofit) / realized;
    };
}
