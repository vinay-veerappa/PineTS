// SPDX-License-Identifier: AGPL-3.0-only
// Margin admission of entries as on TradingView (Pine v6):
//   - a market order filling at the open is checked against the equity at its placement (the
//     previous close), with its margin at the fill price (BATS:AAPL 1D, 100 % of equity, margin 100:
//     equity 11,869.15 at the signal's close, open leg 255 × 46.60 = 11,883.00 at the next open → no
//     fill, although the equity at that open was 11,912.50; a pyramiding add at margin 10 rejected
//     with 107.07 available at the previous close for 135.76, 144.56 at the open);
//   - a reversal whose open leg fitted at placement but not at the fill is dropped whole: the held
//     position stays open (AAPL above: the long is kept to a later signal);
//   - a reversal whose open leg did not fit already at placement only closes the position
//     (BINANCE:BTCUSDT 1D, fixed 1 BTC: short 0.81132 closed by the long entry at 123,306.44, no
//     long, equity 115,775.84; CME_MINI_DL:ES1! 1D: short 1 closed, no long of 2);
//   - a stop entry sized to reverse a position that another exit closed first fills its whole
//     quantity from flat when its base quantity fits, then the margin call trims it (ES1! 1D: sell
//     stop of 2 + 2 after the long's stop exit, 4 contracts at 4,363.25 for equity 865,776, margin
//     call 1 contract at the low, 3 held to the exit); when its own quantity does not fit, the part
//     sized to close the position fills alone (BATS:AAPL 1D: 205 + 209 shares, a short of 205).

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(decl: string, body: string, ohlc: Bar[]) {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 86_400_000, closeTime: (i + 2) * 86_400_000 - 1, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'stock' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("reversal margin"${decl})
${body}`;
    const ctx = await new PineTS(provider, 'TEST:X', 'D', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!;
}
const flat = (p: number): Bar => [p, p, p, p];
const rows = (s: any) => s.closedtrades.map((t: any) => [t.entry_id, t.exit_id, t.exit_price, Math.abs(t.size)]);

describe('market orders: margin against the equity at placement', () => {
    it('a reversal fitting at placement but not at the fill is dropped whole, the long stays open', async () => {
        // long 100 at 50; signal close 55 → equity 10,500, short sized 190 (+100 to close). Next open
        // 55.40: 190 × 55.40 = 10,526 > 10,500 (equity at the open: 10,540)
        const s = await run(
            ', initial_capital = 10000, default_qty_type = strategy.percent_of_equity, default_qty_value = 100, margin_long = 100, margin_short = 100',
            `if bar_index == 0
    strategy.entry("L", strategy.long, qty = 100)
if bar_index == 2
    strategy.entry("S", strategy.short)`,
            [flat(50), flat(50), flat(55), [55.4, 55.6, 55.2, 55.5], flat(55.5)],
        );
        expect(rows(s)).toEqual([]);
        expect(s.position_size).toBe(100);
    });

    it('the same reversal fitting at the fill reverses', async () => {
        // next open 55.20: 190 × 55.20 = 10,488 ≤ 10,500
        const s = await run(
            ', initial_capital = 10000, default_qty_type = strategy.percent_of_equity, default_qty_value = 100, margin_long = 100, margin_short = 100',
            `if bar_index == 0
    strategy.entry("L", strategy.long, qty = 100)
if bar_index == 2
    strategy.entry("S", strategy.short)`,
            [flat(50), flat(50), flat(55), [55.2, 55.2, 54.9, 55], flat(55)],
        );
        expect(rows(s)).toEqual([['L', 'S', 55.2, 100]]);
        expect(s.position_size).toBe(-190);
    });

    it('a fixed-size reversal not fitting at placement closes the position only', async () => {
        // short of 200 at the 55 close needs 11,000 against 10,500
        const s = await run(
            ', initial_capital = 10000, margin_long = 100, margin_short = 100',
            `if bar_index == 0
    strategy.entry("L", strategy.long, qty = 100)
if bar_index == 2
    strategy.entry("S", strategy.short, qty = 200)`,
            [flat(50), flat(50), flat(55), [55.4, 55.6, 55.2, 55.5], flat(55.5)],
        );
        expect(rows(s)).toEqual([['L', 'S', 55.4, 100]]);
        expect(s.position_size).toBe(0);
    });

    it('a pyramiding add is checked against the equity and held margin at the previous close', async () => {
        // margin 50: long 100 at 50, close 45 → 9,500 − 0.5 × 4,500 = 7,250 available; the add of 319
        // at the 45.50 open needs 7,257.25 (7,275 available at the open)
        const s = await run(
            ', initial_capital = 10000, pyramiding = 2, margin_long = 50, margin_short = 50',
            `if bar_index == 0
    strategy.entry("L", strategy.long, qty = 100)
if bar_index == 2
    strategy.entry("L2", strategy.long, qty = 319)`,
            [flat(50), flat(50), flat(45), [45.5, 45.6, 45.4, 45.5], flat(45.5)],
        );
        expect(s.opentrades.map((t: any) => [t.entry_id, t.size])).toEqual([['L', 100]]);
    });
});

describe('reversal-sized stop entry filling after another exit closed the position', () => {
    it('fills its whole quantity from flat when the base quantity fits, then the margin call trims it', async () => {
        // long 2 at 100, capital 300; sell stop 95 sized 2 + 2, the long's stop exit at 97 fills first
        // on the way down (equity 294); 4 × 95 = 380 does not fit, 2 × 95 = 190 does. At the 94 low:
        // equity 298 for 376 → margin call 1
        const s = await run(
            ', initial_capital = 300, margin_long = 100, margin_short = 100',
            `if bar_index == 0
    strategy.entry("L", strategy.long, qty = 2)
if bar_index == 1
    strategy.entry("SS", strategy.short, stop = 95, qty = 2)
    strategy.exit("XL", "L", stop = 97)`,
            [flat(100), flat(100), [99, 99.5, 94, 94.5], flat(94.5)],
        );
        expect(rows(s)).toEqual([
            ['L', 'XL', 97, 2],
            ['SS', 'Close position order', 94, 1],
        ]);
        expect(s.position_size).toBe(-3);
    });

    it('fills only the part sized to close the position when its own quantity does not fit', async () => {
        // TV, BATS:AAPL 1D: 205 + 209 shares after the long of 205 closed at 44.95; 209 × 44.95 =
        // 9,394.55 against 9,348.77 → a short of 205. Here: long 10 at 100, capital 1,000; sell stop 96
        // sized 10 + 11 after the long's stop exit at 97 (equity 970, 11 × 96 = 1,056) → short 10
        const s = await run(
            ', initial_capital = 1000, margin_long = 100, margin_short = 100',
            `if bar_index == 0
    strategy.entry("L", strategy.long, qty = 10)
if bar_index == 1
    strategy.entry("SS", strategy.short, stop = 96, qty = 11)
    strategy.exit("XL", "L", stop = 97)`,
            [flat(100), flat(100), [99, 99.5, 94, 94.5], flat(94.5)],
        );
        expect(rows(s)).toEqual([['L', 'XL', 97, 10]]);
        expect(s.opentrades.map((t: any) => [t.entry_id, t.entry_price, t.size])).toEqual([['SS', 96, -10]]);
    });
});
