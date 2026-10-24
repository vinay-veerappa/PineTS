// SPDX-License-Identifier: AGPL-3.0-only
// strategy(backtest_fill_limits_assumption = N): a limit entry fills once price trades N ticks past
// its level. When the bar opens past the limit by fewer than N ticks, the fill is at the limit, not
// at the open; only an open past the limit by N ticks or more fills at the open. Measured on
// TradingView (BATS:AAPL 1D and CME_MINI_DL:ES1! 1D, N = 200 and N = 3: 93 entries opened inside
// the band, all at the limit; 122 opened past it, all at the open).

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(body: string, ohlc: Bar[], mintick: number, ticks: number) {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 86400000, closeTime: (i + 2) * 86400000 - 1, open, high, low, close, volume: 1 }));
    const pricescale = Math.round(1 / mintick);
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'stock' as const, currency: 'USD', timezone: 'UTC', mintick, pointvalue: 1, mincontract: 1, minmove: 1, pricescale, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("bfla", initial_capital = 1000000, backtest_fill_limits_assumption = ${ticks}, default_qty_type = strategy.fixed, default_qty_value = 1)
${body}`;
    const ctx = await new PineTS(provider, 'TEST:X', 'D', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!;
}

const entryOn0 = (limit: number) => `if bar_index == 0
    strategy.entry("LL", strategy.long, limit = ${limit})`;

describe('backtest_fill_limits_assumption: limit entry on a bar that opens past the limit', () => {
    it('opens inside the band, trades N ticks past later: fills at the limit (AAPL 1D, N = 200)', async () => {
        // BATS:AAPL 1D, 2019-05-06 .. 05-10: limit 51.95 placed on the first bar. The next two bars open
        // below it (51.47, 50.475) but never trade 200 ticks under it (49.95): no fill. The third opens
        // at 50.10 (185 ticks past) and reaches 49.165: TradingView fills at 51.95.
        const s = await run(
            entryOn0(51.95),
            [
                [51.0725, 52.21, 50.875, 52.12],
                [51.47, 51.854375, 50.20625, 50.715],
                [50.475, 51.335, 50.4375, 50.725],
                [50.1, 50.42, 49.165, 50.18],
                [49.35475, 49.7125, 48.1925, 49.295],
            ],
            0.01,
            200,
        );
        expect(s.opentrades.length).toBe(1);
        expect(s.opentrades[0].entry_bar_index).toBe(3);
        expect(s.opentrades[0].entry_price).toBe(51.95);
    });

    it('same rule on a futures tick (ES1! 1D, mintick 0.25, N = 200)', async () => {
        // CME_MINI_DL:ES1! 1D, 2021-02-16 .. 02-22: limit 3,920; the 3,910.5 open stays above 3,870
        // (200 ticks under the limit); the 3,905.5 open reaches 3,861.25: TradingView fills at 3,920.
        const s = await run(
            entryOn0(3920),
            [
                [3929, 3932.25, 3896.5, 3928],
                [3928.25, 3936, 3880.5, 3909.5],
                [3910.5, 3931, 3890.25, 3903],
                [3905.5, 3914.5, 3861.25, 3873.5],
            ],
            0.25,
            200,
        );
        expect(s.opentrades.length).toBe(1);
        expect(s.opentrades[0].entry_bar_index).toBe(3);
        expect(s.opentrades[0].entry_price).toBe(3920);
    });

    it('a small band (AAPL 1D, N = 3): open 2 ticks past the limit fills at the limit', async () => {
        // BATS:AAPL 1D 2019-07-16: limit 51.17, open 51.1475, low 50.875 → TradingView 51.17.
        const s = await run(entryOn0(51.17), [[51.0225, 51.4675, 51, 51.3025], [51.1475, 51.5275, 50.875, 51.125]], 0.01, 3);
        expect(s.opentrades[0].entry_price).toBe(51.17);
    });

    it('an open past the limit by N ticks or more fills at the open (AAPL 1D, N = 200)', async () => {
        // BATS:AAPL 1D 2020-03-16: limit 68.90, open 60.4875 (841 ticks past) → TradingView 60.49.
        const s = await run(entryOn0(68.9), [[66.2225, 69.98, 63.2375, 69.4925], [60.4875, 64.77, 60, 60.5525]], 0.01, 200);
        expect(s.opentrades[0].entry_price).toBe(60.49);
    });

    it('a sell limit mirrors it: open inside the band above the limit fills at the limit', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.entry("SS", strategy.short, limit = 101)`,
            [[100, 100.5, 99.5, 100], [101.02, 101.5, 100.9, 101.2]],
            0.01,
            3,
        );
        expect(s.opentrades[0].entry_price).toBe(101);
    });

    it('opens inside the band and never trades N ticks past: no fill', async () => {
        const s = await run(entryOn0(51.95), [[51.0725, 52.21, 50.875, 52.12], [51.47, 51.854375, 50.20625, 50.715]], 0.01, 200);
        expect(s.opentrades.length).toBe(0);
    });

    it('without the assumption (N = 0) an open past the limit still fills at the open', async () => {
        const s = await run(entryOn0(51.95), [[51.0725, 52.21, 50.875, 52.12], [51.47, 51.854375, 50.20625, 50.715]], 0.01, 0);
        expect(s.opentrades[0].entry_price).toBe(51.47);
    });
});
