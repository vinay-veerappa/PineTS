// SPDX-License-Identifier: AGPL-3.0-only
// strategy.exit legs given as na, and strategy.close / close_all arguments given as variables.
// Behavior measured on TradingView (BINANCE:BTCUSDT 1h, Pine v6):
//   - strategy.exit with every price leg na places no order; re-called that way, it cancels the
//     pending exit with the same id. A single na leg on a re-call removes just that leg.
//   - na trail_points / trail_offset / qty / qty_percent are absent.
//   - strategy.close(qty_percent = p) / (qty = q) with variables close that part of the position;
//     qty_percent = na closes all of it. A variable comment is stored as its string.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(script: string, ohlc: Bar[]) {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 1000, closeTime: (i + 1) * 1000 + 999, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'futures' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("na legs", default_qty_type = strategy.fixed, default_qty_value = 4, margin_long = 0, margin_short = 0)
float nan = na
if bar_index == 0
    strategy.entry("L", strategy.long)
${script}`;
    const ctx = await new PineTS(provider, 'TEST:X', '1', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!;
}

// entry at bar 1's open (100); bar 3 dips to 90 and spikes to 121 (open nearer the low: low first)
const BARS: Bar[] = [[100, 100.5, 99.5, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 121, 90, 105], [105, 106, 104, 105]];

describe('strategy.exit legs given as na', () => {
    it('every price leg na: no order, the trade stays open', async () => {
        const s = await run('strategy.exit("x", "L", limit = nan, stop = nan)', BARS);
        expect(s.closedtrades).toHaveLength(0);
        expect(s.position_size).toBe(4);
    });

    it('re-called with every leg na, the pending exit is cancelled', async () => {
        const s = await run(
            `if bar_index == 1
    strategy.exit("x", "L", stop = 95)
if bar_index == 2
    strategy.exit("x", "L", limit = nan, stop = nan)`,
            BARS,
        );
        expect(s.closedtrades).toHaveLength(0);
        expect(s.position_size).toBe(4);
    });

    it('re-called with only the stop na, the stop leg is removed and the target stays', async () => {
        const s = await run(
            `if bar_index == 1
    strategy.exit("x", "L", limit = 120, stop = 95)
if bar_index == 2
    strategy.exit("x", "L", limit = 120, stop = nan)`,
            BARS,
        );
        expect(s.closedtrades).toHaveLength(1);
        expect(s.closedtrades[0].exit_price).toBe(120);
    });

    it('na trail arguments are absent: the loss leg still works', async () => {
        const s = await run('strategy.exit("x", "L", loss = 500, trail_points = nan, trail_offset = nan)', BARS);
        expect(s.closedtrades).toHaveLength(1);
        expect(s.closedtrades[0].exit_price).toBe(95);
    });

    it('na qty and qty_percent close the whole position', async () => {
        const s = await run('strategy.exit("x", "L", qty = nan, qty_percent = nan, loss = 500)', BARS);
        expect(s.closedtrades).toHaveLength(1);
        expect(s.closedtrades[0].size).toBe(4);
    });
});

describe('strategy.close / close_all arguments given as variables', () => {
    it('qty_percent and qty from variables close that part; qty_percent = na closes the rest', async () => {
        const s = await run(
            `p = input.int(25)
q = input.float(1)
string cm = "half"
if bar_index == 1
    strategy.close("L", comment = cm, qty_percent = p)
if bar_index == 2
    strategy.close("L", qty = q)
if bar_index == 3
    strategy.close("L", qty_percent = nan)`,
            BARS,
        );
        expect(s.closedtrades.map((t: any) => t.size)).toEqual([1, 1, 2]);
        expect(s.closedtrades[0].exit_comment).toBe('half');
        expect(s.position_size).toBe(0);
    });

    it('close_all stores a variable comment as its string', async () => {
        const s = await run(
            `string cm = "flat"
if bar_index == 2
    strategy.close_all(comment = cm)`,
            BARS,
        );
        expect(s.closedtrades).toHaveLength(1);
        expect(s.closedtrades[0].exit_comment).toBe('flat');
    });
});
