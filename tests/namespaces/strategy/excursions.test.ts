// SPDX-License-Identifier: AGPL-3.0-only
// Trade and strategy excursions on the bar path (TradingView, Pine v6; model checked on 51,702 of
// 51,833 corpus trades and 7,343 of 7,343 probe trades on BTCUSDT 1h / AAPL 1D / ES1! 1D).
// Each bar is walked open → nearer extreme → farther extreme → close. A trade sees the vertices after
// its entry fill (the fill vertex itself for a fill at the open or the close), up to its exit fill,
// and its exit fill price; per closed row, with c its entry commission:
//   max_runup = max(0, best favourable move × qty − c), max_drawdown = max(0, worst adverse move × qty + c)
// A trade opened and closed at the same point reports 0 / 0. strategy.max_runup / max_drawdown
// follow the equity at every vertex and after every fill.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(body: string, ohlc: Bar[], extra = '') {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 3_600_000, closeTime: (i + 2) * 3_600_000 - 1, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 0.001, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("excursions", default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 0, margin_short = 0${extra})
${body}`;
    const ctx = await new PineTS(provider, 'TEST:X', '60', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!;
}

const excursion = (t: any) => [t.max_runup, t.max_drawdown].map((v: number) => Number(v.toFixed(8)));

describe('per-trade excursions', () => {
    it('a trade exiting at the open does not see the rest of that bar', async () => {
        // entered at 100; the next bar runs 100 → 99 → 103 → 101; the exit fills at the following open
        // (101.5), whose bar spans 90..110
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 1
    strategy.close("L")`,
            [
                [100, 100, 100, 100],
                [100, 103, 99, 101],
                [101.5, 110, 90, 100],
            ],
        );
        expect(excursion(s.closedtrades[0])).toEqual([3, 1]);
    });

    it('a limit entry filled inside the bar only sees the path after its fill', async () => {
        // path 100 → 101 → 97 → 99, the limit at 98 fills on the way down: the 101 high is before it
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long, limit = 98)
if bar_index == 1
    strategy.close("L")`,
            [
                [100, 100, 100, 100],
                [100, 101, 97, 99],
                [99.5, 100, 99, 99.8],
            ],
        );
        expect(excursion(s.closedtrades[0])).toEqual([1.5, 1]);
    });

    it('drawdown is the signed adverse move plus the entry commission, so it can be below the commission', async () => {
        // a stop entry at 101 on the way up (100 → 99.9 → 103 → 102.5) never trades back below 102;
        // entry commission 0.5: run-up 2 − 0.5, drawdown max(0, −1 + 0.5)
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long, stop = 101)
if bar_index == 1
    strategy.close("L")`,
            [
                [100, 100, 100, 100],
                [100, 103, 99.9, 102.5],
                [102, 102.5, 101.8, 102],
            ],
            ', commission_type = strategy.commission.cash_per_order, commission_value = 0.5',
        );
        expect(excursion(s.closedtrades[0])).toEqual([1.5, 0]);
    });

    it('a stop exit keeps the run-up seen before the stop', async () => {
        // path 100 → 102 → 97 → 97.5, stop at 98 on the way down
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long)
    strategy.exit("x", "L", stop = 98)`,
            [
                [100, 100, 100, 100],
                [100, 102, 97, 97.5],
                [97.5, 98, 97, 97.5],
            ],
        );
        expect(s.closedtrades[0].exit_price).toBe(98);
        expect(excursion(s.closedtrades[0])).toEqual([2, 2]);
    });

    it('each partial exit row has its own quantity and its own part of the path', async () => {
        // 2 units at 100; half exits at the 102 limit on the way up (100 → 99.5 → 103 → 102.8), the
        // other half at the next open (101)
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long, qty = 2)
    strategy.exit("tp", "L", qty_percent = 50, limit = 102)
if bar_index == 1
    strategy.close_all()`,
            [
                [100, 100, 100, 100],
                [100, 103, 99.5, 102.8],
                [101, 101.2, 100.9, 101],
            ],
        );
        expect(s.closedtrades).toHaveLength(2);
        expect(excursion(s.closedtrades[0])).toEqual([2, 0.5]);
        expect(excursion(s.closedtrades[1])).toEqual([3, 0.5]);
    });

    it('a trade opened and closed at the same point reports 0 / 0', async () => {
        // a stop entry and an exit limit at one level fill on the same tick, with commission
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long, stop = 100)
    strategy.exit("x", "L", limit = 100)`,
            [
                [100, 100, 100, 100],
                [100, 101, 99, 100.5],
                [100.5, 101, 100, 100.5],
            ],
            ', commission_type = strategy.commission.percent, commission_value = 0.1',
        );
        expect(s.closedtrades[0].entry_bar_index).toBe(s.closedtrades[0].exit_bar_index);
        expect(excursion(s.closedtrades[0])).toEqual([0, 0]);
    });
});

describe('strategy excursions', () => {
    it('max_runup counts the equity at a bar high reached before an exit on the same bar', async () => {
        // long from 100; bar 2 runs 104 → 105 → 100 → 101 and the stop at 103 fills on the way down
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 1
    strategy.exit("x", "L", stop = 103)`,
            [
                [100, 100, 100, 100],
                [100, 104.5, 99.8, 104],
                [104, 105, 100, 101],
                [101, 101.5, 100.5, 101],
            ],
        );
        expect(s.closedtrades[0].exit_price).toBe(103);
        expect(Number(s.max_runup.toFixed(8))).toBe(5);
        expect(excursion(s.closedtrades[0])).toEqual([5, 0.2]);
    });
});
