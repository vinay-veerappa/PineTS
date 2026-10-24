// SPDX-License-Identifier: AGPL-3.0-only
// Margin on the bar path (TradingView, Pine v6, BINANCE:BTCUSDT 1h / BATS:AAPL 1D):
//   - a position opened by an entry filled inside the bar is not margin-checked at the points the
//     path passed before that fill (a sell stop filled on the way down from the high: no call at the
//     open or the high);
//   - an entry filled inside the bar is admitted against the equity at its fill, not at the open (a
//     sell stop reversal whose open leg no longer fits at the fill closes the long and opens nothing).

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(body: string, ohlc: Bar[], extra: string) {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 3_600_000, closeTime: (i + 2) * 3_600_000 - 1, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 0.001, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("margin path"${extra})
${body}`;
    const ctx = await new PineTS(provider, 'TEST:X', '60', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!;
}

describe('margin on the bar path', () => {
    it('a short opened inside the bar is not margin-called at the open or the high before its fill', async () => {
        // 100 short at the 99 stop on a bar opening at its high (100); at 100 the short would need
        // 10,000 against 9,900, but it does not exist yet; after the fill the bar only falls
        const s = await run(
            `if bar_index == 0
    strategy.entry("S", strategy.short, stop = 99, qty = 100)`,
            [
                [100, 100.2, 99.5, 100],
                [100, 100, 98, 98.5],
                [98.5, 98.8, 98.2, 98.5],
            ],
            ', initial_capital = 10000, margin_long = 100, margin_short = 100',
        );
        expect(s.closedtrades).toHaveLength(0);
        expect(s.position_size).toBe(-100);
    });

    it('a stop reversal is admitted against the equity at its fill', async () => {
        // long 1 from 100 at 50% margin with 51 of capital; the 95 sell stop reverses it: at the fill the
        // equity is 46 for a 47.5 open leg (it was 49.5 at the 98.5 open) → the long closes, no short
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long, qty = 1)
if bar_index == 1
    strategy.entry("S", strategy.short, stop = 95, qty = 1)`,
            [
                [100, 100, 100, 100],
                [100, 100.5, 99.8, 100],
                [98.5, 98.6, 94, 94.5],
                [94.5, 94.8, 94.2, 94.5],
            ],
            ', initial_capital = 51, margin_long = 50, margin_short = 50',
        );
        expect(s.closedtrades).toHaveLength(1);
        expect(s.closedtrades[0].exit_id).toBe('S');
        expect(s.closedtrades[0].exit_price).toBe(95);
        expect(s.position_size).toBe(0);
    });
});
