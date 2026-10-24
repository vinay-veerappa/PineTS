// SPDX-License-Identifier: AGPL-3.0-only
// Exits on the bar a limit / stop entry fills (TradingView broker emulator). The bar moves
// open → nearer extreme → farther extreme → close; the entry fills where that path first reaches its
// level, and only the path AFTER the fill can trigger its exits:
//   - a leg the bar reached before the fill does not fill on that bar;
//   - the bar's open is not a gap price for the trade (it opened later);
//   - a leg already breached at the fill exits at the fill price;
//   - market entries filled at the open still see the whole bar.
// Rules measured on TradingView (BINANCE:BTCUSDT 1h, ~3,400 trades of limit / stop entries with
// same-bar brackets); the bars below are built so each expected fill follows from the path by hand.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(script: string, ohlc: Bar[]) {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 1000, closeTime: (i + 1) * 1000 + 999, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'futures' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("entry bar exits", default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 0, margin_short = 0)
if bar_index == 0
${script}`;
    const ctx = await new PineTS(provider, 'TEST:X', '1', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!;
}

describe('exits on the bar a limit / stop entry fills', () => {
    it('a take-profit the bar reached before the fill waits for a later bar', async () => {
        // Bar 1: open nearer the low → 100 → 97 → 105 → 104. The sell limit fills at 103 on the rise,
        // after the low: the take-profit at 98 is not reached again until bar 2.
        const s = await run(
            `    strategy.entry("S", strategy.short, limit = 103)
    strategy.exit("X", "S", limit = 98, stop = 110)`,
            [[100, 101, 99, 100], [100, 105, 97, 104], [104, 104.5, 97.5, 98]],
        );
        expect(s.closedtrades).toHaveLength(1);
        expect(s.closedtrades[0].entry_price).toBe(103);
        expect(s.closedtrades[0].exit_bar_index).toBe(2);
        expect(s.closedtrades[0].exit_price).toBe(98);
    });

    it('a stop-loss the bar reached before a stop entry filled does not fire; the later take-profit does', async () => {
        // Bar 1: open nearer the high → 100 → 104 → 90 → 92. The sell stop fills at 95 on the fall
        // from the high: the stop-loss at 102 was only reached before, the take-profit at 91 after.
        const s = await run(
            `    strategy.entry("S", strategy.short, stop = 95)
    strategy.exit("X", "S", limit = 91, stop = 102)`,
            [[100, 101, 99, 100], [100, 104, 90, 92], [92, 93, 91.5, 92]],
        );
        expect(s.closedtrades).toHaveLength(1);
        expect(s.closedtrades[0].exit_bar_index).toBe(1);
        expect(s.closedtrades[0].exit_price).toBe(91);
        expect(s.closedtrades[0].profit).toBeCloseTo(4, 9);
    });

    it('the open of the fill bar is not a gap price for the new trade', async () => {
        // Bar 1: open nearer the high → 101 → 101.5 → 94 → 96. The buy limit fills at 95 on the fall;
        // the open above the take-profit (100) came before the trade existed, and the rest of the
        // path (94, then 96) reaches neither leg.
        const s = await run(
            `    strategy.entry("L", strategy.long, limit = 95)
    strategy.exit("X", "L", limit = 100, stop = 90)`,
            [[100, 101, 99, 100], [101, 101.5, 94, 96], [96, 97, 95, 96]],
        );
        expect(s.closedtrades).toHaveLength(0);
        expect(s.opentrades).toHaveLength(1);
        expect(s.opentrades[0].entry_price).toBe(95);
    });

    it('a leg already breached at the fill exits at the fill price', async () => {
        // The short's stop-loss (102) is below its limit entry (103): breached the moment the entry fills.
        const s = await run(
            `    strategy.entry("S", strategy.short, limit = 103)
    strategy.exit("X", "S", limit = 95, stop = 102)`,
            [[100, 101, 99, 100], [100, 105, 97, 104], [104, 104.5, 97.5, 98]],
        );
        expect(s.closedtrades).toHaveLength(1);
        expect(s.closedtrades[0].exit_bar_index).toBe(1);
        expect(s.closedtrades[0].exit_price).toBe(103);
        expect(s.closedtrades[0].profit).toBe(0);
    });

    it('a market entry filled at the open still sees the whole bar', async () => {
        // Bar 1: open nearer the low → 100 → 99 → 106 → 104: the take-profit at 105 fills on bar 1.
        const s = await run(
            `    strategy.entry("L", strategy.long)
    strategy.exit("X", "L", limit = 105, stop = 95)`,
            [[100, 101, 99, 100], [100, 106, 99, 104], [104, 105, 103, 104]],
        );
        expect(s.closedtrades).toHaveLength(1);
        expect(s.closedtrades[0].exit_bar_index).toBe(1);
        expect(s.closedtrades[0].exit_price).toBe(105);
    });
});
