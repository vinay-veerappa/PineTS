// SPDX-License-Identifier: AGPL-3.0-only
// Which trades a strategy.exit applies to (TradingView, Pine v6, BINANCE:BTCUSDT 1h / BATS:AAPL 1D):
//   - an exit for an entry id that is neither open nor pending when it is called places nothing:
//     `strategy.exit("x", "D", ...)` called once just before `strategy.entry("D", ...)` never fires;
//   - a short added at an open where the exit's stop is already breached is spared, and leaves that
//     exit for good, take-profit included;
//   - when the bar opens past one leg and reaches the other later, the leg past the open fills there.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(body: string, ohlc: Bar[], extra = '') {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 86_400_000, closeTime: (i + 2) * 86_400_000 - 1, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("exit lifecycle", default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 0, margin_short = 0${extra})
${body}`;
    const ctx = await new PineTS(provider, 'TEST:X', '1D', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!;
}

const bars: Bar[] = [
    [100, 100.5, 99.5, 100],
    [100, 100.5, 99.5, 100],
    [99, 99.5, 90, 91],
    [91, 92, 90, 91],
];

describe('an exit for an entry that does not exist yet', () => {
    it('called before the entry, while flat, places nothing', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.exit("x", "D", stop = 95)
    strategy.entry("D", strategy.long)`,
            bars,
        );
        expect(s.closedtrades).toHaveLength(0);
        expect(s.opentrades).toHaveLength(1);
    });

    it('called after the entry, it works', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.entry("D", strategy.long)
    strategy.exit("x", "D", stop = 95)`,
            bars,
        );
        expect(s.closedtrades).toHaveLength(1);
        expect(s.closedtrades[0].exit_id).toBe('x');
        expect(s.closedtrades[0].exit_price).toBe(95);
    });
});

describe("a position's exit and an opposite entry reached at the same point", () => {
    // TV (AAPL / TSLA / NVDA 1D, BTCUSDT 1h): a long's stop and a short stop entry. Both orders fill in
    // full: the short entry was queued as a reversal (qty 2); an exit filling after the entry opens a
    // position under its own id.
    const sameLevel = (first: 'exit' | 'entry') => {
        const exit = 'strategy.exit("x", "L", stop = 99)';
        const entry = 'strategy.entry("S", strategy.short, stop = 99)';
        return `if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 1
    ${first === 'exit' ? exit : entry}
    ${first === 'exit' ? entry : exit}`;
    };
    const touch: Bar[] = [
        [100, 100.5, 99.5, 100],
        [100, 100.5, 99.5, 100],
        [100, 100.2, 98, 98.5],
        [98.5, 98.8, 98.2, 98.5],
    ];

    it('at one level, the exit placed first fills first, then the entry with its queued quantity', async () => {
        const s = await run(sameLevel('exit'), touch);
        expect(s.closedtrades[0].exit_id).toBe('x');
        expect(s.opentrades.map((t) => [t.entry_id, t.size])).toEqual([['S', -2]]);
    });

    it('at one level, the entry placed first reverses the position; the exit then opens one of its own', async () => {
        const s = await run(sameLevel('entry'), touch);
        expect(s.closedtrades[0].exit_id).toBe('S');
        expect(s.opentrades.map((t) => [t.entry_id, t.size, t.entry_price])).toEqual([
            ['S', -1, 99],
            ['x', -1, 99],
        ]);
    });

    const gap = (exitStop: number, entryStop: number) => `if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 1
    strategy.entry("S", strategy.short, stop = ${entryStop})
    strategy.exit("x", "L", stop = ${exitStop})`;
    const gapDown: Bar[] = [
        [100, 100.5, 99.5, 100],
        [100, 100.5, 99.5, 100],
        [97, 97.5, 96.5, 97],
        [97, 97.5, 96.5, 97],
    ];

    it('at a gap open past both, the order whose level is nearer the open fills first: the exit', async () => {
        const s = await run(gap(98, 99), gapDown);
        expect(s.closedtrades[0].exit_id).toBe('x');
        expect(s.closedtrades[0].exit_price).toBe(97);
        expect(s.opentrades.map((t) => [t.entry_id, t.size])).toEqual([['S', -2]]);
    });

    it('at a gap open past both, the order whose level is nearer the open fills first: the entry', async () => {
        const s = await run(gap(99, 98), gapDown);
        expect(s.closedtrades[0].exit_id).toBe('S');
        expect(s.opentrades.map((t) => [t.entry_id, t.size])).toEqual([
            ['S', -1],
            ['x', -1],
        ]);
    });
});

describe('a breached stop at the open', () => {
    // S1 short at bar 1's open (100); at bar 1's close, S2 is added and the exit placed: stop 97
    // (already below the price), take-profit 99. Bar 2 opens at 99.8 and falls through 99.
    const body = `if bar_index == 0
    strategy.entry("S1", strategy.short)
if bar_index == 1
    strategy.entry("S2", strategy.short)
    strategy.exit("x", stop = 97, limit = 99)`;
    const ohlc: Bar[] = [
        [100, 100.5, 99.5, 100],
        [100, 100.5, 99.5, 100],
        [99.8, 100, 98.5, 98.8],
        [98.8, 99, 95, 96],
        [96, 96.5, 95.5, 96],
    ];

    it('fills the held short at the open, before the take-profit the bar reaches later', async () => {
        const s = await run(body, ohlc, ', pyramiding = 2');
        expect(s.closedtrades).toHaveLength(1);
        expect(s.closedtrades[0].entry_id).toBe('S1');
        expect(s.closedtrades[0].exit_price).toBe(99.8);
        expect(s.closedtrades[0].exit_bar_index).toBe(2);
    });

    it('spares the short added at that open, which leaves the exit for good', async () => {
        const s = await run(body, ohlc, ', pyramiding = 2');
        expect(s.opentrades).toHaveLength(1);
        expect(s.opentrades[0].entry_id).toBe('S2');
    });
});
