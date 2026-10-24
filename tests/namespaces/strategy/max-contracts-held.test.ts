// SPDX-License-Identifier: AGPL-3.0-only
// strategy.max_contracts_held_* when several orders fill at one bar open. TradingView fills the buy
// orders before the sell orders there, and its maximum follows that order:
//   - strategy.close("L") + strategy.entry("L") on one bar (BINANCE:BTCUSDT 1h, the re-entry fills
//     at the open the close fills at): max_contracts_held_long 2 for a position of 1 (also 2 × the
//     trade size on two BTCUSDT 1D backtester captures with the same pattern);
//   - a short add and a strategy.exit stop already breached, filling at one open (BINANCE:BTCUSDT
//     1h): the stop closes the old short, the add survives, max_contracts_held_short 1.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(body: string, ohlc: Bar[], decl = '') {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 3_600_000, closeTime: (i + 2) * 3_600_000 - 1, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("max held", initial_capital = 1000000, default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 0, margin_short = 0${decl})
${body}`;
    const ctx = await new PineTS(provider, 'TEST:X', '60', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!;
}
const flat = (p = 100): Bar => [p, p + 0.5, p - 0.5, p];
const held = (s: any) => [s.max_contracts_held_all, s.max_contracts_held_long, s.max_contracts_held_short];

describe('max_contracts_held_* with several fills at one open', () => {
    it('close + same-side re-entry: the re-entry is counted before the close', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 2
    strategy.close("L", comment = "OUT")
    strategy.entry("L", strategy.long, comment = "IN")`,
            [flat(), flat(101), flat(102), flat(103), flat(104)],
        );
        expect(s.closedtrades.map((t: any) => [t.entry_bar_index, t.exit_bar_index, t.exit_comment])).toEqual([[1, 3, 'OUT']]);
        expect(s.position_size).toBe(1);
        expect(held(s)).toEqual([2, 2, 0]);
    });

    it('short add + breached stop at one open: the stop closes the old short first', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.entry("S1", strategy.short)
if bar_index == 1
    strategy.entry("S2", strategy.short)
    strategy.exit("x", stop = close * 0.97)`,
            [flat(), flat(101), flat(102), flat(103), flat(104)],
            ', pyramiding = 2',
        );
        expect(s.closedtrades.map((t: any) => [t.entry_id, t.exit_id, t.exit_bar_index])).toEqual([['S1', 'x', 2]]);
        expect(s.position_size).toBe(-1);
        expect(held(s)).toEqual([1, 0, 1]);
    });

    it('close_all + opposite entry at one open (BINANCE:BTCUSDT 1h: long 1, short 1)', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 2
    strategy.close_all(comment = "ALL")
    strategy.entry("S", strategy.short)`,
            [flat(), flat(101), flat(102), flat(103), flat(104)],
        );
        expect(s.position_size).toBe(-1);
        expect(held(s)).toEqual([1, 1, 1]);
    });

    it('fills inside the bar are not taken as fills at the open (BINANCE:BTCUSDT 1h: 1, 1, 1)', async () => {
        // long from a stop-limit at the bar 1 open; on bar 2 its stop exit at 99.60, a short stop-limit
        // at 99 and that short's stop at 99.40 on the way back up
        const s = await run(
            `if bar_index == 0
    strategy.entry("SLL", strategy.long, stop = 100, limit = 101)
    strategy.entry("SLS", strategy.short, stop = 99, limit = 98.5)
strategy.exit("x1", "SLL", stop = 99.6)
strategy.exit("x2", "SLS", stop = 99.4)`,
            [[99.9, 99.95, 99.85, 99.9], [100, 100.3, 99.7, 100], [100, 100.2, 98.8, 99.8], flat(99.8)],
        );
        expect(s.closedtrades.map((t: any) => [t.entry_id, t.entry_price, t.exit_id, t.exit_price])).toEqual([
            ['SLL', 100, 'x1', 99.6],
            ['SLS', 99, 'x2', 99.4],
        ]);
        expect(held(s)).toEqual([1, 1, 1]);
    });

    it('a reversal at the open counts the new side only', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 2
    strategy.entry("S", strategy.short)`,
            [flat(), flat(101), flat(102), flat(103)],
        );
        expect(s.position_size).toBe(-1);
        expect(held(s)).toEqual([1, 1, 1]);
    });
});
