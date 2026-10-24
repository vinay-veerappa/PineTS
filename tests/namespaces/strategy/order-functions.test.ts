// SPDX-License-Identifier: AGPL-3.0-only
// Order-function rules measured on TradingView (Pine v6, BINANCE:BTCUSDT 1h / BATS:AAPL 1D /
// CME_MINI_DL:ES1! 1D):
//   - a strategy.entry / strategy.order call with the id of an unfilled one modifies it, also on the
//     bar it was placed, across both commands;
//   - an OCA group is its name and its type together;
//   - strategy.exit with a price and a tick distance for one leg uses the level reached first; with
//     trail_price and trail_points, the earlier activation; its oca_name makes it a reduce-type member;
//   - a trail whose activation level the close has reached is active from that close;
//   - close / exit quantities are floored to the symbol's step, 0 meaning everything;
//   - a cash_per_order fee is shared by the trades one order closes;
//   - with process_orders_on_close, a limit / stop entry the close has reached fills at that close.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(body: string, ohlc: Bar[], extra = '', mincontract = 0.001) {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 3_600_000, closeTime: (i + 2) * 3_600_000 - 1, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("orders", default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 0, margin_short = 0${extra})
${body}`;
    const ctx = await new PineTS(provider, 'TEST:X', '60', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!;
}

const flat: Bar = [100, 100.5, 99.5, 100];
const flats = (n: number): Bar[] => Array.from({ length: n }, () => flat);

describe('modifying an order by its id', () => {
    it('a second strategy.entry with the same id on the same bar replaces the first', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.entry("M", strategy.long, comment = "m1")
    strategy.entry("M", strategy.long, qty = 2, comment = "m2")`,
            flats(3),
            ', pyramiding = 3',
        );
        expect(s.opentrades.map((t) => [t.entry_comment, t.size])).toEqual([['m2', 2]]);
    });

    it('strategy.order modifies a strategy.entry with the same id', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.entry("R", strategy.long)
    strategy.order("R", strategy.long, qty = 2, comment = "r-order")`,
            flats(3),
            ', pyramiding = 3',
        );
        expect(s.opentrades.map((t) => [t.entry_comment, t.size])).toEqual([['r-order', 2]]);
    });
});

describe('OCA groups', () => {
    it('a reduce-type and a cancel-type order sharing a name are different groups', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.order("C1", strategy.long, qty = 1, limit = 99.8, oca_name = "p", oca_type = strategy.oca.reduce)
    strategy.order("C2", strategy.long, qty = 2, limit = 99.7, oca_name = "p", oca_type = strategy.oca.cancel)`,
            [flat, [100, 100.2, 99.5, 99.9], flat],
        );
        expect(s.position_size).toBe(3);
    });

    it("strategy.exit's oca_name reduces a reduce-type order of the group by what the exit filled", async () => {
        // long 2; the exit takes 1 at 100.4, which leaves 1 on the reduce-type sell stop of 2
        const s = await run(
            `if bar_index == 0
    strategy.entry("M", strategy.long, qty = 2)
if bar_index == 1
    strategy.exit("mx", "M", qty = 1, limit = 100.4, oca_name = "ord")
    strategy.order("mo", strategy.short, qty = 2, stop = 99.6, oca_name = "ord", oca_type = strategy.oca.reduce)`,
            [flat, flat, [100, 100.6, 99.9, 100.2], [100.2, 100.3, 99.4, 99.5], flat],
        );
        expect(s.position_size).toBe(0);
    });
});

describe('strategy.exit levels', () => {
    it('profit and limit: the take-profit nearer to the entry', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long)
    strategy.exit("x", "L", profit = 50, limit = 101)`,
            [flat, [100, 100.2, 99.8, 100], [100, 101.5, 99.9, 101.2], flat],
        );
        expect(s.closedtrades[0].exit_price).toBe(100.5);
    });

    it('Pine v5: the limit wins over profit (the command ignores profit when limit is not na)', async () => {
        const bars = [flat, [100, 100.2, 99.8, 100], [100, 101.5, 99.9, 101.2], flat].map(([open, high, low, close], i) => ({ openTime: (i + 1) * 3_600_000, closeTime: (i + 2) * 3_600_000 - 1, open, high, low, close, volume: 1 }));
        const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 0.001, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
        const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
        const src = `//@version=5
strategy("v5 precedence", default_qty_type = strategy.fixed, default_qty_value = 1)
if bar_index == 0
    strategy.entry("L", strategy.long)
    strategy.exit("x", "L", profit = 50, limit = 101)`;
        const ctx = await new PineTS(provider, 'TEST:X', '60', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
        expect(ctx.strategy!.closedtrades[0].exit_price).toBe(101);
    });

    it('loss and stop: the stop nearer to the entry', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long)
    strategy.exit("x", "L", loss = 50, stop = 99)`,
            [flat, [100, 100.2, 99.8, 100], [100, 100.1, 98.5, 98.8], flat],
        );
        expect(s.closedtrades[0].exit_price).toBe(99.5);
    });

    it('trail_price and trail_points: the activation reached first', async () => {
        // trail_points 50 → 100.5, trail_price 102: armed at 100.5 on the way up, 30 ticks behind the
        // 101 high → 100.70
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long)
    strategy.exit("x", "L", trail_price = 102, trail_points = 50, trail_offset = 30)`,
            [flat, [100, 100.2, 99.8, 100], [100, 101, 99.9, 100.1], flat],
        );
        expect(s.closedtrades[0].exit_price).toBe(100.7);
    });

    it('a trail placed on a close past its activation level is active from that close', async () => {
        // short from 101; activation 100 (100 ticks), placed on a 99 close: peak 99, 40 ticks → 99.40;
        // the next bar opens at 99.2 and rises
        const s = await run(
            `if bar_index == 0
    strategy.entry("S", strategy.short)
if bar_index == 1
    strategy.exit("x", "S", trail_points = 100, trail_offset = 40)`,
            [[101, 101, 101, 101], [101, 101.2, 98.8, 99], [99.2, 99.9, 99.1, 99.8], flat],
        );
        expect(s.closedtrades[0].exit_price).toBe(99.4);
    });
});

describe('quantities and fees', () => {
    it('close / exit quantities are floored to the step, and 0 closes everything', async () => {
        // AAPL-like step of 1: a long of 4; close(qty = 1.7) closes 1, then close(qty = 0.4) closes the rest
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long, qty = 4)
if bar_index == 1
    strategy.close("L", qty = 1.7)
if bar_index == 2
    strategy.close("L", qty = 0.4)`,
            flats(5),
            '',
            1,
        );
        expect(s.closedtrades.map((t) => t.size)).toEqual([1, 3]);
        expect(s.position_size).toBe(0);
    });

    it("a cash_per_order fee is shared by the trades one order closes", async () => {
        // two longs of 1 (5 each to enter); close_all closes both with one 5 fee: 2.5 each
        const s = await run(
            `if bar_index == 0
    strategy.entry("A", strategy.long)
if bar_index == 1
    strategy.entry("B", strategy.long)
if bar_index == 2
    strategy.close_all()`,
            flats(5),
            ', pyramiding = 2, commission_type = strategy.commission.cash_per_order, commission_value = 5',
        );
        expect(s.closedtrades.map((t) => t.commission)).toEqual([7.5, 7.5]);
    });
});

describe('process_orders_on_close', () => {
    it('a limit entry the close has reached fills at that close', async () => {
        // a buy limit 50 ticks above the close is marketable: it fills at the 100 close of its bar
        const s = await run(
            `if bar_index == 0
    strategy.entry("LL", strategy.long, limit = close + 0.5)`,
            [flat, [100.3, 100.8, 100.2, 100.6], flat],
            ', process_orders_on_close = true',
        );
        expect(s.opentrades[0].entry_bar_index).toBe(0);
        expect(s.opentrades[0].entry_price).toBe(100);
    });
});
