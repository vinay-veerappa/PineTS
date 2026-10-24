// SPDX-License-Identifier: AGPL-3.0-only
// Trailing stops and fill order along the bar's path, as on TradingView (BINANCE:BTCUSDT 1h and
// CME ES 1D, Pine v6). The bar moves open → nearer extreme → farther extreme → close:
//   - a trail armed on the way to the high fires on the way down, before a stop-loss further below
//     (case "05", bar 2375: trail at 79,690 under a 79,890 high fills before the stop at 78,842.56);
//   - a trail armed on an earlier bar fills at the open when the bar opens past its trigger
//     (ES 1D: short trail at 3,752, next open 3,760.75 → 3,760.75);
//   - trail_offset = 0 fills at the arming price; trail_points = 0 arms at the entry;
//   - a trade a limit entry opened inside the bar arms only on the path after its fill;
//   - an exit queued with a reversal entry keeps its stop when the stop is on the right side of
//     the new position (case "24");
//   - two pending entries fill in the order the path reaches them.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(body: string, ohlc: Bar[], decl = 'default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 0, margin_short = 0') {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 1000, closeTime: (i + 1) * 1000 + 999, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("t", ${decl})
${body}`;
    const ctx = await new PineTS(provider, 'TEST:X', '1', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!;
}
const exits = (s: any) => s.closedtrades.map((t: any) => [t.exit_id, t.exit_price, t.exit_bar_index]);
const flat: Bar = [100, 100.5, 99.5, 100];

describe('trailing stops along the path', () => {
    it('armed on the way up, fires on the way down before the stop-loss below', async () => {
        // long at 100; arm at +5 (105), offset 2; bar 2 opens 100.5, high 108 first (7.5 < 8.5), low 92
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long)
strategy.exit("x", "L", trail_points = 500, trail_offset = 200, loss = 600)`,
            [flat, [100, 100.4, 99.8, 100.2], [100.5, 108, 92, 95], flat],
        );
        expect(exits(s)).toEqual([['x', 106, 2]]);
    });

    it('armed on an earlier bar: a bar opening past the trigger fills at its open', async () => {
        // short at 100; armed at 95 (5 down) on bar 1, peak 94 → trigger 96; bar 2 opens at 97
        const s = await run(
            `if bar_index == 0
    strategy.entry("S", strategy.short)
strategy.exit("x", "S", trail_points = 500, trail_offset = 200)`,
            [flat, [99.5, 99.6, 94, 95.5], [97, 98, 96.5, 97.5], flat],
        );
        expect(exits(s)).toEqual([['x', 97, 2]]);
    });

    it('trail_offset = 0 fills at the arming price', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long)
strategy.exit("x", "L", trail_points = 200, trail_offset = 0)`,
            [flat, [100, 100.4, 99.8, 100.2], [100.2, 104, 99, 99.5], flat],
        );
        expect(exits(s)).toEqual([['x', 102, 2]]);
    });

    it('trail_points = 0 arms at the entry: a short fills at entry + offset when the bar rises first', async () => {
        // short entered at bar 1's open (100); the bar goes up to 103 first, then down to 96
        const s = await run(
            `if bar_index == 0
    strategy.entry("S", strategy.short)
strategy.exit("x", "S", trail_points = 0, trail_offset = 200)`,
            [flat, [100, 103, 96, 97], flat],
        );
        expect(exits(s)).toEqual([['x', 102, 1]]);
    });

    it('a limit entry filled inside the bar arms only on the path after its fill', async () => {
        // buy limit 99 fills on the way down from the high (bar 1: open 100, high 101.5 first, low 98);
        // the arming level 101 is only reached before the fill
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long, limit = 99)
strategy.exit("x", "L", trail_points = 200, trail_offset = 100)`,
            [flat, [100, 101.5, 98, 98.5], [98.5, 99, 98, 98.6], [98.6, 98.8, 98.2, 98.5]],
        );
        expect(s.closedtrades).toHaveLength(0);
        expect(s.opentrades[0].entry_price).toBe(99);
    });
});

describe('trailing stops per trade', () => {
    it('each pyramided trade arms its own trail from its own entry', async () => {
        // A at 100, B at 102; trail 2 points / offset 1: A arms at 102 (bar 2's open), B at 104
        // (never). Bar 3 goes up to 102.6 then down to 101: only A's trail fires, at 101.6
        const s = await run(
            `if bar_index == 0
    strategy.entry("A", strategy.long)
if bar_index == 1
    strategy.entry("B", strategy.long)
strategy.exit("x", trail_points = 200, trail_offset = 100)`,
            [flat, [100, 100.4, 99.8, 100.2], [102, 102.2, 101.9, 102], [102, 102.6, 101, 101.2], [101.2, 101.4, 101, 101.2]],
            'default_qty_type = strategy.fixed, default_qty_value = 1, pyramiding = 2, margin_long = 0, margin_short = 0',
        );
        expect(s.closedtrades.map((t: any) => [t.entry_id, t.exit_id, t.exit_price, t.exit_bar_index])).toEqual([['A', 'x', 101.6, 3]]);
        expect(s.opentrades.map((t: any) => t.entry_id)).toEqual(['B']);
    });
});

describe('exits queued with a reversal entry', () => {
    it('a stop on the right side of the new position is kept', async () => {
        // long at bar 1; on bar 2 the script reverses to short with a stop 2% above the close
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 2
    strategy.entry("S", strategy.short)
    strategy.exit("xs", "S", stop = close * 1.02)`,
            [flat, flat, flat, [100, 100.5, 99.5, 100], [100, 102.5, 99.8, 102], flat],
        );
        expect(s.closedtrades.at(-1)).toMatchObject({ entry_id: 'S', exit_id: 'xs', exit_price: 102, exit_bar_index: 4 });
    });
});

describe('entry fills in path order', () => {
    it('a buy limit below and a sell limit above, both pending from flat, fill in path order', async () => {
        // bar 1 opens 100, low 98 first (2 < 3), then high 103: the buy limit at 99 fills first and
        // the sell limit at 102 then closes it (queued while flat, it has the quantity of 1)
        const s = await run(
            `if bar_index == 0
    strategy.entry("S", strategy.short, limit = 102)
    strategy.entry("L", strategy.long, limit = 99)`,
            [flat, [100, 103, 98, 101], flat],
        );
        expect(s.closedtrades.map((t: any) => [t.entry_id, t.entry_price, t.exit_id, t.exit_price])).toEqual([['L', 99, 'S', 102]]);
        expect(s.position_size).toBe(0);
    });

    it("an entry filled after the bar's exits still meets its own exit on the rest of the path", async () => {
        // bar 1: open 100, high 103 first, then down to 92, close 96. Down from the high: the buy
        // limit at 97 fills, its stop at 95 closes it, the sell stop at 93 opens a short; back up
        // to the close the short's stop at 94 fills (TV, a premium backtester on BTCUSDT 1D)
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long, limit = 97)
    strategy.entry("S", strategy.short, stop = 93)
strategy.exit("lx", "L", stop = 95)
strategy.exit("sx", "S", stop = 94)`,
            [flat, [100, 103, 92, 96], flat],
        );
        expect(s.closedtrades.map((t: any) => [t.entry_id, t.entry_price, t.exit_id, t.exit_price, t.exit_bar_index])).toEqual([
            ['L', 97, 'lx', 95, 1],
            ['S', 93, 'sx', 94, 1],
        ]);
    });
});
