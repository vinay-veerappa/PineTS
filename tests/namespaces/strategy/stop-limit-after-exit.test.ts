// SPDX-License-Identifier: AGPL-3.0-only
// TradingView (BINANCE:BTCUSDT 1h, controlled case "22"): on a bar rising through a short's stop
// (64,614) and a pending stop-limit long's stop (64,664), the short's exit fills first, then the
// stop-limit long, then the long's take-profit — whose strategy.exit was placed while the short was
// open, for the long's entry.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

describe('a stop-limit entry against the position, after its exit on the path', () => {
    it("the short's stop, then the stop-limit long, then the long's take-profit, on one bar", async () => {
        const ohlc: Bar[] = [
            [100, 100.5, 99.5, 100],
            [100, 101, 99.5, 100.5],
            [101, 110, 100.8, 109],
            [109, 109.5, 108.5, 109],
        ];
        const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 60000, closeTime: (i + 2) * 60000 - 1, open, high, low, close, volume: 1 }));
        const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
        const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
        const src = `//@version=6
strategy("t", default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 0, margin_short = 0)
if bar_index == 0
    strategy.entry("S", strategy.short)
    strategy.entry("L", strategy.long, stop = 104.5, limit = 105)
strategy.exit("xs", "S", stop = 104)
strategy.exit("xl", "L", limit = 107.5)`;
        const s: any = (await new PineTS(provider, 'TEST:X', '1', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src))).strategy;
        expect(s.closedtrades.map((t: any) => [t.entry_id, t.entry_price, t.exit_id, t.exit_price, t.exit_bar_index])).toEqual([
            ['S', 100, 'xs', 104, 2],
            ['L', 104.5, 'xl', 107.5, 2],
        ]);
    });
});
