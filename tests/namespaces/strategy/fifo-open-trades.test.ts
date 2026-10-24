// SPDX-License-Identifier: AGPL-3.0-only
// The open trades the script sees under close_entries_rule (TradingView, Pine v6, BINANCE:BTCUSDT 1h /
// BATS:AAPL 1D / CME_MINI_DL:ES1! 1D): with A 1, B 2 and C 3 open,
//   FIFO: close("C", qty = 1) → B 2, C 3; then strategy.order short 1.5 → B 0.5, C 3; then close("B") → C 2
//         (a close for an id takes the oldest trades, capped by what is left of that id: B's 2 minus the
//         0.5 the unnamed order took from it, since that order took each id's quantity oldest first);
//   ANY:  close("C", qty = 1) → A 1, B 2, C 2; then strategy.order short 1.5 → B 1.5, C 2; then close("B") → C 2.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';
import { openTradeList } from '../../../src/namespaces/strategy/utils';

const flat = [100, 100.5, 99.5, 100];

async function openAfter(rule: 'FIFO' | 'ANY', lastStep: number) {
    const steps = [
        'strategy.entry("A", strategy.long, qty = 1)',
        'strategy.entry("B", strategy.long, qty = 2)',
        'strategy.entry("C", strategy.long, qty = 3)',
        'strategy.close("C", qty = 1)',
        'strategy.order("o", strategy.short, qty = 1.5)',
        'strategy.close("B")',
    ].slice(0, lastStep + 1);
    const body = steps.map((s, i) => `if bar_index == ${i}\n    ${s}`).join('\n');
    const n = steps.length + 2;
    const bars = Array.from({ length: n }, (_, i) => ({ openTime: (i + 1) * 3_600_000, closeTime: (i + 2) * 3_600_000 - 1, open: flat[0], high: flat[1], low: flat[2], close: flat[3], volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 0.001, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("fifo", pyramiding = 5, margin_long = 0, margin_short = 0, close_entries_rule = "${rule}")
${body}`;
    const ctx = await new PineTS(provider, 'TEST:X', '60', n, undefined, bars[n - 1].closeTime).run(new Indicator(src));
    return openTradeList(ctx).map((t) => `${t.entry_id}:${Number(Math.abs(t.size as number).toFixed(6))}`);
}

describe('open trades under close_entries_rule = "FIFO"', () => {
    it('a close for an id takes the oldest trade', async () => {
        expect(await openAfter('FIFO', 3)).toEqual(['B:2', 'C:3']);
    });

    it('a later unnamed order takes the oldest trades', async () => {
        expect(await openAfter('FIFO', 4)).toEqual(['B:0.5', 'C:3']);
    });

    it("a close for an id is capped by that id's own quantity, booked on the oldest trades", async () => {
        expect(await openAfter('FIFO', 5)).toEqual(['C:2']);
    });
});

describe('open trades under close_entries_rule = "ANY"', () => {
    it("a close for an id takes that id's trade", async () => {
        expect(await openAfter('ANY', 3)).toEqual(['A:1', 'B:2', 'C:2']);
    });

    it('a later unnamed order takes the oldest trades, not the id closed before', async () => {
        expect(await openAfter('ANY', 4)).toEqual(['B:1.5', 'C:2']);
    });

    it('a close for an id takes what is left of it', async () => {
        expect(await openAfter('ANY', 5)).toEqual(['C:2']);
    });
});
