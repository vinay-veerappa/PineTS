// SPDX-License-Identifier: AGPL-3.0-only
// Opposite market orders filling together at one open, as on TradingView (BINANCE:BTCUSDT 1h,
// controlled case "29" and probes "o01"–"o15", "w-*", "v-*"; price P = the open, fixed quantities):
//   - buy orders fill before sell orders, whatever the order they were placed in;
//   - a strategy.entry placed after a pending opposite strategy.entry / strategy.order is sized to
//     reverse it (its own quantity b plus the pending s);
//   - margin is checked against the position held before the bar: an order reversing a position
//     opened at this same open is checked for its whole quantity and dropped whole when it fails;
//   - such an entry filling while flat and too large for the account: dropped when b + s − m fits
//     (m = min(b, s)), else it fills m when m fits (fitted, not understood).

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

async function run(body: string, capital: number) {
    const ohlc = [100, 100, 100, 100];
    const bars = ohlc.map((c, i) => ({ openTime: (i + 1) * 60000, closeTime: (i + 2) * 60000 - 1, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("t", initial_capital = ${capital}, default_qty_type = strategy.fixed, default_qty_value = 1)
${body}`;
    const s: any = (await new PineTS(provider, 'TEST:X', '1', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src))).strategy;
    return {
        position: s.position_size,
        open: s.opentrades.map((t: any) => [t.entry_id, t.size]),
        closed: s.closedtrades.map((t: any) => [t.entry_id, t.exit_id, t.size]),
    };
}
const pair = (a: string, aq: number, b: string, bq: number) => `if bar_index == 0
    strategy.entry("${a}", strategy.${a === 'L' ? 'long' : 'short'}, qty = ${aq})
    strategy.entry("${b}", strategy.${b === 'L' ? 'long' : 'short'}, qty = ${bq})`;

describe('opposite market orders at one open', () => {
    it('buy orders fill first: two strategy.order calls, short then long', async () => {
        const r = await run(
            `if bar_index == 0
    strategy.order("S", strategy.short)
    strategy.order("L", strategy.long)`,
            1000,
        );
        expect(r).toEqual({ position: 0, open: [], closed: [['L', 'S', 1]] });
    });

    it('short 1 then long 1 with the capital for 2: the long of 2 fills first, the short closes 1', async () => {
        expect(await run(pair('S', 1, 'L', 1), 250)).toEqual({ position: 1, open: [['L', 1]], closed: [['L', 'S', 1]] });
    });

    it('short 1 then long 1 with the capital for 1: only the short fills', async () => {
        expect(await run(pair('S', 1, 'L', 1), 150)).toEqual({ position: -1, open: [['S', -1]], closed: [] });
    });

    it('long 1 then short 1 with the capital for 1: only the long fills', async () => {
        expect(await run(pair('L', 1, 'S', 1), 150)).toEqual({ position: 1, open: [['L', 1]], closed: [] });
    });

    it('long 1 then short 1 with the capital for 2: the short reverses the long', async () => {
        expect(await run(pair('L', 1, 'S', 1), 250)).toEqual({ position: -1, open: [['S', -1]], closed: [['L', 'S', 1]] });
    });

    it('a reversal of a position held from an earlier bar checks only its new leg', async () => {
        const r = await run(
            `if bar_index == 0
    strategy.entry("L0", strategy.long)
if bar_index == 1
    strategy.entry("S", strategy.short)`,
            150,
        );
        expect(r).toEqual({ position: -1, open: [['S', -1]], closed: [['L0', 'S', 1]] });
    });

    it('short 1 then long 2, too large for the account: the long of 1 fills and the short closes it', async () => {
        expect(await run(pair('S', 1, 'L', 2), 150)).toEqual({ position: 0, open: [], closed: [['L', 'S', 1]] });
    });

    it('short 1 then long 2 with the capital for 2: only the short fills', async () => {
        expect(await run(pair('S', 1, 'L', 2), 250)).toEqual({ position: -1, open: [['S', -1]], closed: [] });
    });

    it('short 2 (rejected) then long 1: the long of 1 fills', async () => {
        expect(await run(pair('S', 2, 'L', 1), 150)).toEqual({ position: 1, open: [['L', 1]], closed: [] });
    });
});
