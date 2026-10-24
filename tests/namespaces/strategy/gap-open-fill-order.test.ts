// SPDX-License-Identifier: AGPL-3.0-only
// Several orders breached at one gapped open, as on TradingView (BATS:AAPL 1D, CME_MINI_DL:ES1! 1D):
//   - they fill in order of their level's distance to the open, nearest first (20 / 20 take-profit
//     pairs and 14 / 14 stop-entry pairs; two strategy.exit take-profits on AAPL and ES);
//   - strategy.oca.cancel still applies between them: only the nearest fills (11 / 11 stop pairs,
//     16 / 16 limit pairs);
//   - strategy.oca.reduce applies between limit orders (the farther one is reduced by the nearer
//     one's fill: 34 / 34) but not between stop orders, which all fill in full (29 / 29: stop entries,
//     stop strategy.order adds and closing stop orders).

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(src: string, ohlc: Bar[]) {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 86400000, closeTime: (i + 2) * 86400000 - 1, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'stock' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const ctx = await new PineTS(provider, 'TEST:X', 'D', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!;
}

const header = `//@version=6
strategy("gap", initial_capital = 10000000, default_qty_type = strategy.fixed, default_qty_value = 1, pyramiding = 3)
`;

describe('several orders breached at one gapped open', () => {
    it('reduce-group take-profit limits: the nearer one fills, the other is reduced away (AAPL 1D 2015-02-11)', async () => {
        // long 3 at 30.04; TP1 30.60 / TP2 30.69 (qty 1 each) and SL 30.32 (qty 3) in one reduce group;
        // the bar opens at 30.6925: TradingView books TP2 at 30.69, position 2
        const s = await run(
            header +
                `if bar_index == 0
    strategy.entry("L", strategy.long, qty = 3)
if bar_index == 1
    strategy.order("TP1", strategy.short, qty = 1, limit = 30.60, oca_name = "x", oca_type = strategy.oca.reduce)
    strategy.order("TP2", strategy.short, qty = 1, limit = 30.69, oca_name = "x", oca_type = strategy.oca.reduce)
    strategy.order("SL", strategy.short, qty = 3, stop = 30.32, oca_name = "x", oca_type = strategy.oca.reduce)`,
            [
                [29.6375, 29.96, 29.6075, 29.93],
                [30.0425, 30.5375, 30.04, 30.505],
                [30.6925, 31.23, 30.625, 31.22],
            ],
        );
        expect(s.closedtrades.map((t) => t.exit_id)).toEqual(['TP2']);
        expect(s.closedtrades[0].exit_price).toBe(30.69);
        expect(s.position_size).toBe(2);
    });

    it('reduce-group stop entries: both fill in full, the nearer first (AAPL 1D 2015-08-25)', async () => {
        // E1 (2) at 27.23 and E2 (3) at 27.31, one reduce group; the bar opens at 27.7775: TradingView
        // fills E2 3, then E1 2 → position 5
        const s = await run(
            header +
                `if bar_index == 0
    strategy.entry("E1", strategy.long, qty = 2, stop = 27.23, oca_name = "y", oca_type = strategy.oca.reduce)
    strategy.entry("E2", strategy.long, qty = 3, stop = 27.31, oca_name = "y", oca_type = strategy.oca.reduce)`,
            [
                [23.7175, 27.2, 23, 25.78],
                [27.7775, 27.7775, 25.875, 25.935],
            ],
        );
        expect(s.position_size).toBe(5);
        expect(s.opentrades.map((t) => [t.entry_id, t.size])).toEqual([
            ['E2', 3],
            ['E1', 2],
        ]);
        expect(s.opentrades[0].entry_price).toBe(27.78);
    });

    it('reduce-group closing stop orders: both fill, the nearer first (AAPL 1D 2016-01-28)', async () => {
        // long 3 at 24.98; S1 24.44 / S2 24.37 (qty 1 each, one reduce group); open 24.01: TradingView
        // fills S2 then S1 → position 1
        const s = await run(
            header +
                `if bar_index == 0
    strategy.entry("L", strategy.long, qty = 3)
if bar_index == 1
    strategy.order("S1", strategy.short, qty = 1, stop = 24.44, oca_name = "s", oca_type = strategy.oca.reduce)
    strategy.order("S2", strategy.short, qty = 1, stop = 24.37, oca_name = "s", oca_type = strategy.oca.reduce)`,
            [
                [25.38, 25.3825, 24.8025, 24.86],
                [24.9825, 25.22, 24.5175, 24.9975],
                [24.01, 24.157225, 23.335, 23.355],
            ],
        );
        expect(s.closedtrades.map((t) => t.exit_id)).toEqual(['S2', 'S1']);
        expect(s.position_size).toBe(1);
    });

    it('reduce-group limit entries: the nearer fills, the farther is reduced by it (AAPL 1D 2014-12-08)', async () => {
        // E1 (3) at 28.63 and E2 (2) at 28.54; open 28.525: TradingView fills E2 2, then E1 3 - 2 = 1
        const s = await run(
            header +
                `if bar_index == 0
    strategy.entry("E1", strategy.long, qty = 3, limit = 28.63, oca_name = "e", oca_type = strategy.oca.reduce)
    strategy.entry("E2", strategy.long, qty = 2, limit = 28.54, oca_name = "e", oca_type = strategy.oca.reduce)`,
            [
                [28.9975, 29.02, 28.66, 28.75],
                [28.525, 28.662, 27.905, 28.1],
            ],
        );
        expect(s.opentrades.map((t) => [t.entry_id, t.size])).toEqual([
            ['E2', 2],
            ['E1', 1],
        ]);
    });

    it('cancel-group limit entries: only the nearer fills', async () => {
        // AAPL 1D (16 / 16): D1 (3) at the higher limit, D2 (2) at the lower; a gap below both fills D2
        const s = await run(
            header +
                `if bar_index == 0
    strategy.entry("D1", strategy.long, qty = 3, limit = 28.63, oca_name = "d", oca_type = strategy.oca.cancel)
    strategy.entry("D2", strategy.long, qty = 2, limit = 28.54, oca_name = "d", oca_type = strategy.oca.cancel)`,
            [
                [28.9975, 29.02, 28.66, 28.75],
                [28.525, 28.662, 27.905, 28.1],
            ],
        );
        expect(s.opentrades.map((t) => [t.entry_id, t.size])).toEqual([['D2', 2]]);
    });

    it('two strategy.exit take-profits: the level nearer the open is booked first (AAPL 1D 2014-11-13)', async () => {
        // long 4 at 27.35; q1 profit 8 ticks (27.43), q2 profit 17 ticks (27.52), qty 1 each; open 27.95:
        // TradingView books q2, then q1, both at 27.95
        const s = await run(
            header +
                `if bar_index == 0
    strategy.entry("L", strategy.long, qty = 4)
if bar_index == 1
    strategy.exit("q1", "L", qty = 1, profit = 8)
    strategy.exit("q2", "L", qty = 1, profit = 17)`,
            [
                [27.175, 27.4375, 27.1, 27.425],
                [27.345, 27.8575, 27.3425, 27.8125],
                [27.95, 28.3625, 27.9, 28.205],
            ],
        );
        expect(s.closedtrades.map((t) => [t.exit_id, t.exit_price])).toEqual([
            ['q2', 27.95],
            ['q1', 27.95],
        ]);
    });

    it('intrabar the path order still decides, and reduce applies between stops', async () => {
        // the lower buy stop E1 (2) is reached first on the way up and reduces E2 (3) to 1
        // (TradingView, BTCUSDT 1h: 107 / 107)
        const s = await run(
            header +
                `if bar_index == 0
    strategy.entry("E1", strategy.long, qty = 2, stop = 27.23, oca_name = "y", oca_type = strategy.oca.reduce)
    strategy.entry("E2", strategy.long, qty = 3, stop = 27.31, oca_name = "y", oca_type = strategy.oca.reduce)`,
            [
                [26.5, 27.2, 26.4, 27],
                [27.1, 27.5, 27.05, 27.4],
            ],
        );
        expect(s.opentrades.map((t) => [t.entry_id, t.size])).toEqual([
            ['E1', 2],
            ['E2', 1],
        ]);
    });
});
