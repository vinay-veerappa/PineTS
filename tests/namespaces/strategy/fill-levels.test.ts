// SPDX-License-Identifier: AGPL-3.0-only
// Fill prices and order levels as on TradingView (Pine v6):
//   - a stop or limit entry whose bar opens beyond its level fills at that open: worse for a stop,
//     better for a limit (all 120 gapped stop entries on BATS:AAPL / CME ES; ES limit 7,119.35 with
//     an open of 7,102.50 fills at 7,102.50);
//   - a price within 1e-4 ticks of the tick grid is on it: `close + 0.2 * atr` = 64,277.98000025
//     places the order at 64,277.98 (BINANCE:BTCUSDT 1h, mintick 0.01);
//   - fractional tick counts: `profit` / `loss` round to the next whole tick away from the entry
//     (30000.4 and 30000.6 → 30001), `trail_offset` truncates (2000.4 / .5 / .6 → 2000);
//   - a level a whole number of ticks from an on-grid entry is exactly on the grid, so it fills
//     when the bar touches it exactly.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(body: string, ohlc: Bar[], extra = '') {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 1000, closeTime: (i + 1) * 1000 + 999, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("fill levels", default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 0, margin_short = 0${extra})
${body}`;
    const ctx = await new PineTS(provider, 'TEST:X', '1', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!;
}

const flat: Bar = [100, 100.5, 99.5, 100];

describe('entries on a gap', () => {
    it('a buy stop gapped through fills at the open', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long, stop = 101)`,
            [flat, [103, 104, 102.5, 103.5], flat],
        );
        expect(s.opentrades[0].entry_price).toBe(103);
    });

    it('a sell stop gapped through fills at the open', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.entry("S", strategy.short, stop = 99)`,
            [flat, [97, 97.5, 96, 97], flat],
        );
        expect(s.opentrades[0].entry_price).toBe(97);
    });

    it('a buy limit with the bar opening below it fills at the open', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long, limit = 99)`,
            [flat, [97, 98, 96.5, 97.5], flat],
        );
        expect(s.opentrades[0].entry_price).toBe(97);
    });

    it('a sell limit with the bar opening above it fills at the open', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.entry("S", strategy.short, limit = 101)`,
            [flat, [103, 104, 102.5, 103.5], flat],
        );
        expect(s.opentrades[0].entry_price).toBe(103);
    });

    it('without a gap the entry fills at its level', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long, stop = 100.3)`,
            [flat, [100, 101, 99.8, 100.8], flat],
        );
        expect(s.opentrades[0].entry_price).toBe(100.3);
    });
});

describe('order levels on the tick grid', () => {
    it('a level within 1e-4 ticks of the grid is placed on it', async () => {
        // 100.00000025 for a sell limit above the close used to round up to 100.01, which bar 1's
        // high of 100.005 never reaches
        const s = await run(
            `if bar_index == 0
    strategy.entry("S", strategy.short, limit = close + 0.10000025)`,
            [[99.9, 99.95, 99.85, 99.9], [99.95, 100.005, 99.9, 99.95], flat],
        );
        expect(s.opentrades[0].entry_price).toBe(100);
    });

    it('fractional profit / loss ticks round to the next whole tick away from the entry', async () => {
        // entry 100 at bar 1's open; profit 30.4 ticks → 0.31 → TP 100.31; bar 2 high 100.30 does
        // not reach it, bar 3 high 100.31 does
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long)
strategy.exit("x", "L", profit = 30.4, loss = 500.6)`,
            [flat, [100, 100.2, 99.9, 100.1], [100.1, 100.3, 100, 100.2], [100.2, 100.31, 100.1, 100.25], flat],
        );
        expect(s.closedtrades).toHaveLength(1);
        expect(s.closedtrades[0].exit_price).toBe(100.31);
        expect(s.closedtrades[0].exit_bar_index).toBe(3);
    });

    it('a fractional trail_offset is truncated to whole ticks', async () => {
        // armed at 100.5 (50 ticks), peak 101; offset 20.6 ticks → 20 → trail 100.80
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long)
strategy.exit("x", "L", trail_points = 50, trail_offset = 20.6)`,
            [flat, [100, 100.2, 99.9, 100.1], [100.1, 101, 100.1, 100.95], [100.95, 100.96, 100.5, 100.6], flat],
        );
        expect(s.closedtrades).toHaveLength(1);
        expect(s.closedtrades[0].exit_price).toBe(100.8);
    });

    it('a tick-based stop exactly at the bar high fills', async () => {
        // TradingView (slippage 2): short at the open 62,630.01 → 62,629.99; loss 20001 ticks →
        // 62,830.00, the next bar's high → stop filled at 62,830.02
        const s = await run(
            `if bar_index == 0
    strategy.entry("S", strategy.short)
strategy.exit("x", "S", loss = 20001, profit = 1000000)`,
            [[62630.01, 62630.5, 62629, 62630.01], [62630.01, 62700, 62600, 62650], [62650, 62830, 62640, 62700], [62700, 62710, 62690, 62700]],
            ', slippage = 2',
        );
        expect(s.closedtrades).toHaveLength(1);
        expect(s.closedtrades[0].entry_price).toBeCloseTo(62629.99, 9);
        expect(s.closedtrades[0].exit_bar_index).toBe(2);
        expect(s.closedtrades[0].exit_price).toBeCloseTo(62830.02, 9);
    });
});
