// SPDX-License-Identifier: AGPL-3.0-only
// Pine v6 evaluates the right operand of `and` / `or` only when the left one does not decide the
// result. A ta.crossover / ta.crossunder there is not evaluated on the other bars, so it compares
// against the values it last saw, not the previous bar's (TradingView: controlled case "23",
// `ta.crossunder(r, 40) or ta.crossunder(r, 30)`, and a pyramiding add
// `strategy.position_size > 0 and ta.crossover(close, ema)`).

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../src';

async function run(src: string, closes: number[]) {
    const bars = closes.map((c, i) => ({ openTime: (i + 1) * 60000, closeTime: (i + 2) * 60000 - 1, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const ctx = await new PineTS(provider, 'TEST:X', '1', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return (ctx.plots['x'].data as any[]).map((p) => p.value);
}

describe('ta calls in the right operand of and / or', () => {
    it('ta.crossover skipped on a bar compares against the values it last saw', async () => {
        // evaluated on bars 0 and 2 only: on bar 2 the last values it saw are bar 0's (99), so
        // 102 > 100 is a cross; bar 1 (101, already above) was never seen
        const x = await run(
            `//@version=6
indicator("t")
gate = bar_index == 0 or bar_index == 2
plot(gate and ta.crossover(close, 100) ? 1 : 0, "x")`,
            [99, 101, 102, 103],
        );
        expect(x).toEqual([0, 0, 1, 0]);
    });

    it('ta.crossunder in the right operand of or', async () => {
        // left operand true on bar 1 (crossunder of 40 is not evaluated then); on bar 2 the right
        // operand compares against bar 0
        const x = await run(
            `//@version=6
indicator("t")
plot(bar_index == 1 or ta.crossunder(close, 40) ? 1 : 0, "x")`,
            [41, 39, 38, 41],
        );
        expect(x).toEqual([0, 1, 1, 0]);
    });

    it('evaluated on every bar, it compares against the previous bar', async () => {
        const x = await run(
            `//@version=6
indicator("t")
plot(ta.crossover(close, 100) ? 1 : 0, "x")`,
            [99, 101, 102, 99, 101],
        );
        expect(x).toEqual([0, 1, 0, 0, 1]);
    });
});
