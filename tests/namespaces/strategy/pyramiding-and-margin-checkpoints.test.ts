// SPDX-License-Identifier: AGPL-3.0-only
// TradingView (BINANCE:BTCUSDT 1h, Pine v6):
//   - pyramiding is counted when an entry fills: with pyramiding = 3, two trades open and two adds
//     queued on one bar, only the first add fills (controlled case "21"). strategy.order is not
//     limited by pyramiding.
//   - the margin is also checked at the bar's other extreme: with a 20 cash_per_order fee, a short
//     margin-called at the high (63,013.66) is margin-called again at the low (62,981.93) of the same
//     bar, because the first call's fee leaves the account short of margin (case "q03", bar 1605).

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(decl: string, body: string, ohlc: Bar[]) {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 1000, closeTime: (i + 1) * 1000 + 999, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 0.001, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("t", ${decl})
${body}`;
    const ctx = await new PineTS(provider, 'TEST:X', '1', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!;
}

const flat: Bar = [100, 100.5, 99.5, 100];

describe('pyramiding', () => {
    it('two adds queued on one bar with room for one: only the first fills', async () => {
        const s = await run(
            'default_qty_type = strategy.fixed, default_qty_value = 1, pyramiding = 3, margin_long = 0, margin_short = 0',
            `if bar_index == 0
    strategy.entry("A", strategy.long)
if bar_index == 1
    strategy.entry("B", strategy.long)
if bar_index == 2
    strategy.entry("C", strategy.long)
    strategy.entry("D", strategy.long)`,
            [flat, flat, flat, flat, flat],
        );
        expect(s.opentrades.map((t: any) => t.entry_id)).toEqual(['A', 'B', 'C']);
    });

    it('strategy.order is not limited by pyramiding', async () => {
        const s = await run(
            'default_qty_type = strategy.fixed, default_qty_value = 1, pyramiding = 1, margin_long = 0, margin_short = 0',
            `if bar_index == 0
    strategy.order("A", strategy.long)
if bar_index == 1
    strategy.order("B", strategy.long)
    strategy.order("C", strategy.long)`,
            [flat, flat, flat, flat],
        );
        expect(s.position_size).toBe(3);
    });
});

describe('margin checkpoints', () => {
    it("a margin call's fee can trigger another call at the bar's other extreme", async () => {
        // short 10 at 100 (fee 20) with 1,059.5 capital, v6 default margin 100%. Bar 2 opens at 101.9
        // nearer its high: at 102 the account is 0.5 short → a small call (and another 20 fee); at the
        // low of 101.5 it is still short of margin → a second call there.
        const s = await run(
            'initial_capital = 1059.5, default_qty_type = strategy.fixed, default_qty_value = 10, commission_type = strategy.commission.cash_per_order, commission_value = 20',
            `if bar_index == 0
    strategy.entry("S", strategy.short)`,
            [flat, [100, 100.4, 99.9, 100], [101.9, 102, 101.5, 101.6], [101.6, 101.7, 101.5, 101.6]],
        );
        const calls = s.closedtrades.filter((t: any) => t.exit_comment === 'Margin call' && t.exit_bar_index === 2);
        expect(calls.map((t: any) => t.exit_price)).toEqual([102, 101.5]);
    });

    it('a position opened at the close is first margin-checked at the next open', async () => {
        // process_orders_on_close: long 10 at bar 0's close (100) with a 20 fee leaves 980 against
        // 1,000 of margin → margin-called at bar 1's open, not at bar 0's close (TV, a public
        // strategy on BTCUSDT 1h)
        const s = await run(
            'initial_capital = 1000, default_qty_type = strategy.fixed, default_qty_value = 10, process_orders_on_close = true, commission_type = strategy.commission.cash_per_order, commission_value = 20',
            `if bar_index == 0
    strategy.entry("L", strategy.long)`,
            [flat, [100.2, 100.4, 100, 100.2], flat],
        );
        const call = s.closedtrades.find((t: any) => t.exit_comment === 'Margin call');
        expect(call).toMatchObject({ exit_bar_index: 1, exit_price: 100.2 });
    });
});
