// SPDX-License-Identifier: AGPL-3.0-only
// TradingView (BINANCE:BTCUSDT 1h, controlled case "15" and sizing probes "z01"–"z14"):
//   - Pine v5's default margin is 0 (no margin model): a v5 strategy sized at 150% of equity trades;
//   - without a margin model (margin 0), percent_of_equity sizing is capped at 100% of equity:
//     120%, 150% and 300% all size 10,000 / 63,465.51 = 0.158. Cash sizing is not capped; at margin
//     50%, 150% of equity is used; at margin 100% (the v6 default) the 150% order is rejected.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

async function run(version: number, decl: string) {
    const ohlc = [100, 100, 100, 100];
    const bars = ohlc.map((c, i) => ({ openTime: (i + 1) * 60000, closeTime: (i + 2) * 60000 - 1, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 0.001, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=${version}
strategy("t", initial_capital = 10000, ${decl})
if bar_index == 0
    strategy.entry("L", strategy.long)`;
    const ctx = await new PineTS(provider, 'TEST:X', '1', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!.position_size;
}
const pct = (v: number) => `default_qty_type = strategy.percent_of_equity, default_qty_value = ${v}`;

describe('margin defaults and percent_of_equity sizing', () => {
    it('v5: no margin model by default, 150% of equity trades capped at 100%', async () => {
        expect(await run(5, pct(150))).toBe(100);
    });

    it('v6 with margin 0: 300% of equity is capped at 100%', async () => {
        expect(await run(6, `${pct(300)}, margin_long = 0, margin_short = 0`)).toBe(100);
    });

    it('v6 with margin 50: 150% of equity is used', async () => {
        expect(await run(6, `${pct(150)}, margin_long = 50, margin_short = 50`)).toBe(150);
    });

    it('v6 default margin 100%: a 150% order is rejected', async () => {
        expect(await run(6, pct(150))).toBe(0);
    });

    it('margin 0: cash sizing above equity is not capped', async () => {
        expect(await run(6, 'default_qty_type = strategy.cash, default_qty_value = 15000, margin_long = 0, margin_short = 0')).toBe(150);
    });
});
