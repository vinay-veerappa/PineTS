// SPDX-License-Identifier: AGPL-3.0-only
// Several strategy.exit orders on one entry, as on TradingView (BINANCE:BTCUSDT 1h, CME ES; probes
// "pe01"–"pe11" and controlled cases "10" / "x10"). Exits share each trade's quantity in the order
// they were first placed: each takes its qty_percent of the trade's entry quantity, its absolute
// qty (oldest trades first), or all of the rest without either, out of what the exits placed
// before it and still working have not taken.
//   - a 50% target placed before a full-size stop leaves the stop half the position; the stop
//     placed first takes all of it and the target never fills;
//   - 60% + 60%: the second gets 40%; qty 3 on a position of 1 takes all of it;
//   - on whole contracts, 50% of 1 contract takes the contract;
//   - an exit that re-calls an id keeps its place, also after it filled on one of the trades;
//   - strategy.close with qty_percent leaves the exits working on the rest;
//   - exits without from_entry placed while a position was open die with it on a reversal.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(body: string, ohlc: Bar[], decl = 'default_qty_type = strategy.fixed, default_qty_value = 1', mincontract = 0.001) {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 1000, closeTime: (i + 1) * 1000 + 999, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("t", margin_long = 0, margin_short = 0, ${decl})
${body}`;
    const ctx = await new PineTS(provider, 'TEST:X', '1', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!;
}
const rows = (s: any) => s.closedtrades.map((t: any) => [t.exit_id, Number(Math.abs(t.size).toFixed(6)), t.exit_price]);
const flat: Bar = [100, 100.5, 99.5, 100];
const LONG = `if bar_index == 0
    strategy.entry("L", strategy.long)
`;
// bar 2 falls to 96 (stops at 97 fill); bar 3 rises to 104 (targets at 103 fill)
const DOWN_THEN_UP: Bar[] = [flat, [100, 100.4, 99.8, 100.2], [100, 100.2, 96, 96.5], [96.5, 104, 96.4, 103.5], flat];

describe('exits sharing an entry', () => {
    it('a 50% target placed first leaves the full-size stop half the position', async () => {
        const s = await run(LONG + `strategy.exit("a", "L", qty_percent = 50, profit = 300)
strategy.exit("b", "L", loss = 300)`, DOWN_THEN_UP);
        // the half the stop leaves is the target's, filled when the next bar reaches it
        expect(rows(s)).toEqual([['b', 0.5, 97], ['a', 0.5, 103]]);
    });

    it('a full-size stop placed first takes all of it: the target never fills', async () => {
        const s = await run(LONG + `strategy.exit("b", "L", loss = 300)
strategy.exit("a", "L", qty_percent = 50, profit = 300)`, DOWN_THEN_UP);
        expect(rows(s)).toEqual([['b', 1, 97]]);
    });

    it('60% then 60%: the second exit gets 40%', async () => {
        const s = await run(LONG + `strategy.exit("a", "L", qty_percent = 60, profit = 300)
strategy.exit("b", "L", qty_percent = 60, loss = 300)`, DOWN_THEN_UP);
        expect(rows(s)).toEqual([['b', 0.4, 97], ['a', 0.6, 103]]);
    });

    it('an absolute qty larger than the position takes all of it', async () => {
        const s = await run(LONG + `strategy.exit("a", "L", qty = 3, profit = 300)
strategy.exit("b", "L", loss = 300)`, DOWN_THEN_UP);
        expect(rows(s)).toEqual([['a', 1, 103]]);
    });

    it('on whole contracts, 50% of 1 contract takes the contract', async () => {
        const s = await run(LONG + `strategy.exit("a", "L", qty_percent = 50, profit = 300)
strategy.exit("b", "L", loss = 300)`, DOWN_THEN_UP, 'default_qty_type = strategy.fixed, default_qty_value = 1', 1);
        expect(rows(s)).toEqual([['a', 1, 103]]);
    });

    it('a re-called exit keeps its place after it filled on an older trade', async () => {
        // A (bar 1) and B (bar 3) of 1 each; "a" (50%) fills on A at bar 3; on bar 5 the stops of
        // both trades are hit: "b" may close all of A's rest but only half of B
        const s = await run(
            `if bar_index == 0 or bar_index == 2
    strategy.entry(bar_index == 0 ? "A" : "B", strategy.long)
strategy.exit("a", qty_percent = 50, profit = 200)
strategy.exit("b", loss = 300)`,
            [flat, [100, 100.4, 99.8, 100.2], [100, 102.5, 99.9, 102], [102, 102.2, 101.5, 102], [102, 102.1, 101.6, 101.8], [101.8, 101.9, 96, 96.5], flat],
            'default_qty_type = strategy.fixed, default_qty_value = 1, pyramiding = 2',
        );
        const b = s.closedtrades.filter((t: any) => t.exit_id === 'b');
        expect(b.reduce((sum: number, t: any) => sum + Math.abs(t.size), 0)).toBeCloseTo(1, 9);
        expect(s.position_size).toBeCloseTo(0.5, 9);
    });
});

describe('exits and other orders', () => {
    it('strategy.close with qty_percent leaves the exits working on the rest', async () => {
        // close half at bar 3's open; the 50% target at 103 fills on bar 3
        const s = await run(LONG + `strategy.exit("a", "L", qty_percent = 50, profit = 300)
strategy.exit("b", "L", loss = 3000)
if bar_index == 2
    strategy.close("L", qty_percent = 50, comment = "half")`, [flat, [100, 100.4, 99.8, 100.2], [100.2, 100.5, 99.9, 100], [100, 104, 99.9, 103.5], flat]);
        expect(rows(s)).toEqual([['Close entry(s) order L', 0.5, 100], ['a', 0.5, 103]]);
    });

    it('a reversal takes the exits without from_entry of the reversed position with it', async () => {
        // short at bar 1; reversal to long queued on bar 2 (fills at bar 3's open, 100); the exits
        // placed while short must not apply to the long on bar 3 (its high of 104 is above 103)
        const s = await run(
            `if bar_index == 0
    strategy.entry("S", strategy.short)
if bar_index == 2
    strategy.entry("L", strategy.long)
strategy.exit("a", profit = 300, loss = 3000)`,
            [flat, [100, 100.4, 99.8, 100.2], [100.2, 100.5, 99.9, 100], [100, 104, 99.9, 101], [101, 101.5, 100.5, 101], flat],
        );
        const longRows = s.closedtrades.filter((t: any) => t.entry_id === 'L');
        expect(longRows.every((t: any) => t.exit_bar_index !== 3)).toBe(true);
    });
});
