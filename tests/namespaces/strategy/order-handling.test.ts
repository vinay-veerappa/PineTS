// SPDX-License-Identifier: AGPL-3.0-only
// Order handling as on TradingView (BINANCE:BTCUSDT 1h unless stated, Pine v6):
//   - process_orders_on_close: a strategy.exit placed on a bar whose stop or limit the close has
//     already reached fills at that close (a stop less slippage, a limit at the close); a level
//     only crossed earlier in the bar is left for the next bar;
//   - on a bar moving against the position first, an exit stop reached before the adverse extreme
//     fills before the margin check at that extreme (short stop 77,965.92 under a 77,999.99 high:
//     closed by the stop, no margin call);
//   - OCA groups: strategy.oca.cancel cancels the other orders of the group when one fills, the
//     one the bar's path reaches first (controlled cases "07 stop entries oca", "x07");
//     strategy.oca.reduce takes the filled quantity off them;
//   - a reversal order's cash_per_order fee is split between its closing and opening legs in
//     proportion to their quantities (0.08103 closed / 0.07953 opened, fee 5 → 2.5233 / 2.4767).

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(decl: string, body: string, ohlc: Bar[]) {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 1000, closeTime: (i + 1) * 1000 + 999, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 0.001, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("orders", ${decl})
${body}`;
    const ctx = await new PineTS(provider, 'TEST:X', '1', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!;
}

const flat: Bar = [100, 100.5, 99.5, 100];

describe('process_orders_on_close and strategy.exit', () => {
    const DECL = 'default_qty_type = strategy.fixed, default_qty_value = 1, slippage = 2, process_orders_on_close = true, margin_long = 0, margin_short = 0';

    it('a stop the close has reached fills at that close, less slippage', async () => {
        const s = await run(DECL, `if bar_index == 0
    strategy.entry("L", strategy.long)
if strategy.position_size > 0
    strategy.exit("x", "L", stop = close)`, [flat, [100, 101, 99, 99.5], flat, flat]);
        expect(s.closedtrades).toHaveLength(1);
        expect(s.closedtrades[0].exit_bar_index).toBe(1);
        expect(s.closedtrades[0].exit_price).toBeCloseTo(99.48, 9);
    });

    it('a limit the close has passed fills at that close', async () => {
        const s = await run(DECL, `if bar_index == 0
    strategy.entry("L", strategy.long)
if strategy.position_size > 0
    strategy.exit("x", "L", limit = close - 0.5)`, [flat, [100, 101, 99, 99.5], flat, flat]);
        expect(s.closedtrades).toHaveLength(1);
        expect(s.closedtrades[0].exit_bar_index).toBe(1);
        expect(s.closedtrades[0].exit_price).toBe(99.5);
    });

    it('a stop crossed earlier in the bar but not at the close waits for the next bar', async () => {
        const s = await run(DECL, `if bar_index == 0
    strategy.entry("L", strategy.long)
if strategy.position_size > 0
    strategy.exit("x", "L", stop = 99.2)`, [flat, [100, 101, 99, 99.5], [99.5, 99.6, 99.1, 99.3], flat]);
        expect(s.closedtrades).toHaveLength(1);
        expect(s.closedtrades[0].exit_bar_index).toBe(2);
        expect(s.closedtrades[0].exit_price).toBeCloseTo(99.18, 9);
    });
});

describe('margin call and an exit stop on the same bar', () => {
    it('the stop reached before the adverse extreme fills; no margin call', async () => {
        // short 10 at 100 with 1,040 capital (v6 default margin 100%): margin call above 102. Bar 2
        // opens at 100.2 nearer its high, goes up to 103 first through the stop at 101, then down
        const s = await run(
            'initial_capital = 1040, default_qty_type = strategy.fixed, default_qty_value = 10',
            `if bar_index == 0
    strategy.entry("S", strategy.short)
if strategy.position_size < 0
    strategy.exit("x", "S", stop = 101)`,
            [flat, [100, 100.3, 99.8, 100.2], [100.2, 103, 97, 102], flat],
        );
        expect(s.closedtrades.map((t: any) => [t.exit_id, t.exit_price, Math.abs(t.size)])).toEqual([['x', 101, 10]]);
    });
});

describe('OCA groups', () => {
    const BRACKET = (type: string) => `if bar_index == 0
    strategy.entry("BO", strategy.long, stop = 101, oca_name = "brk", oca_type = ${type})
    strategy.entry("BD", strategy.short, stop = 99, oca_name = "brk", oca_type = ${type})
if bar_index == 3
    strategy.close_all()`;
    // bar 1 breaks out up; bar 2 falls through 99 (where BD would fill)
    const BARS: Bar[] = [flat, [100.5, 101.5, 100.4, 101.2], [101.2, 101.3, 98.5, 98.8], [98.8, 99, 98.5, 98.7], flat];

    it('strategy.oca.cancel: the first fill cancels the rest of the group', async () => {
        const s = await run('default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 0, margin_short = 0', BRACKET('strategy.oca.cancel'), BARS);
        // BD never fills: BO stays open until close_all
        expect(s.closedtrades.map((t: any) => [t.entry_id, t.entry_price, t.exit_id])).toEqual([['BO', 101, 'Close position order']]);
    });

    it('both triggered on one bar: the one the path reaches first fills', async () => {
        // open 100.1 is nearer the high: up to 101 (BO) first, then down through 99
        const s = await run('default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 0, margin_short = 0', BRACKET('strategy.oca.cancel'), [flat, [100.1, 101.5, 98.5, 99], flat, flat, flat]);
        expect(s.closedtrades.map((t: any) => [t.entry_id, t.entry_price, t.exit_id])).toEqual([['BO', 101, 'Close position order']]);
    });

    it('strategy.oca.reduce: the filled quantity comes off the others', async () => {
        const s = await run(
            'default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 0, margin_short = 0, pyramiding = 2',
            `if bar_index == 0
    strategy.entry("A", strategy.long, qty = 1, stop = 101, oca_name = "g", oca_type = strategy.oca.reduce)
    strategy.entry("B", strategy.long, qty = 3, stop = 102, oca_name = "g", oca_type = strategy.oca.reduce)
if bar_index == 4
    strategy.close_all()`,
            [flat, [100.5, 101.5, 100.4, 101.2], [101.2, 102.5, 101, 102.2], flat, flat, flat],
        );
        expect(s.closedtrades.map((t: any) => [t.entry_id, Math.abs(t.size)])).toEqual([['A', 1], ['B', 2]]);
    });
});

describe('cash_per_order on a reversal', () => {
    it('splits the fee between the legs in proportion to their quantities', async () => {
        const s = await run(
            'default_qty_type = strategy.fixed, default_qty_value = 1, commission_type = strategy.commission.cash_per_order, commission_value = 5, margin_long = 0, margin_short = 0',
            `if bar_index == 0
    strategy.entry("L", strategy.long, qty = 1)
if bar_index == 1
    strategy.entry("S", strategy.short, qty = 3)
if bar_index == 3
    strategy.close_all()`,
            [flat, flat, flat, flat, flat],
        );
        const [l, sh] = s.closedtrades;
        // L: its own entry fee 5 + 1/4 of the reversal order's fee
        expect(l.commission).toBeCloseTo(5 + 5 * (1 / 4), 9);
        // S: 3/4 of the reversal order's fee + the close_all fee
        expect(sh.commission).toBeCloseTo(5 * (3 / 4) + 5, 9);
    });
});
