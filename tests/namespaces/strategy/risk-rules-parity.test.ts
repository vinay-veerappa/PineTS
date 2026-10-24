// SPDX-License-Identifier: AGPL-3.0-only
// strategy.risk.* edge cases measured on TradingView (Pine v6, BINANCE:BTCUSDT 1h, BATS:AAPL 1D):
//   - allow_entry_in(long): a short strategy.entry placed while long becomes a sell of the long's
//     size; when another exit closes the long before it fills, it still fills and opens a short of
//     that size (BTCUSDT 1h: sell stop 0.08051 at 62,350.87 after the long of 0.08051 was closed by
//     its exit on the previous bar; AAPL 1D: short 100 at 44.95).
//   - max_intraday_loss: the day starts at the open of its first bar, after the fills there (AAPL 1D,
//     1 %: a gap down from 55.6 to 52.39 keeps the trade, the loss counted from the open; a drop from
//     the open of a gapped-up day closes it that day). The check right after a fill sees the equity
//     before that fill's closed P&L is booked (BTCUSDT 1h, 1,500 cash: a short held from the previous
//     day reversed at 61,357.63 for +1,260.68, equity 93,183.19 against 93,462.83 at the day start →
//     "Close Position (Max intraday Loss)" at that open, as at 3 other such reversals; 27 halts of 27).
//   - max_intraday_filled_orders(n): a strategy.close_all due at the open where the n-th fill of the
//     day happens still fills before the close-out (BTCUSDT 1h, n = 4: close_all queued after a
//     pyramiding add, both at one open: the three older lots "Close position order", only the add
//     "Close Position (Max number of filled orders in one day)").
//   - max_drawdown: after a margin call, the drawdown of the equity at the call's price (open profit
//     included) from the realized peak is checked; when reached, the position is closed at the bar's
//     close and trading stops (BTCUSDT 1h, 100 % of equity: a call of 0.00284 at the 66,011.47 high
//     leaves 9,690.60, 3.0940 % under 10,000 → "Close Position (Max Drawdown)" at the 65,978.79 close
//     with limits of 3 %, 3.07 %, 3.09 % and 3.092 %, none at 3.10 %; with 3.07 % the equity at the
//     close is 3.047 % under the peak). Without a margin call a bar's close is not checked (BTCUSDT 1D,
//     5 %: 8.07 % at a close, closed only at the next fill).

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close
const H = 3600e3;
const T0 = Date.UTC(2024, 0, 1, 20); // bar 4 opens at midnight UTC

async function run(decl: string, body: string, ohlc: Bar[], tf: '60' | 'D' = '60') {
    const step = tf === 'D' ? 24 * H : H;
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: T0 + i * step, closeTime: T0 + (i + 1) * step - 1, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("risk", initial_capital = 10000, default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 0, margin_short = 0${decl})
${body}`;
    const ctx = await new PineTS(provider, 'TEST:X', tf, bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!;
}
const rows = (s: any) => s.closedtrades.map((t: any) => [t.entry_id, t.entry_bar_index, t.exit_id, t.exit_price, t.exit_bar_index]);
const flat = (p = 100): Bar => [p, p + 0.5, p - 0.5, p];

describe('allow_entry_in(long)', () => {
    it('a short placed while long opens a short of the long size when the long was closed before it filled', async () => {
        const s = await run(
            '',
            `strategy.risk.allow_entry_in(strategy.direction.long)
if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 1
    strategy.entry("SS", strategy.short, stop = 95, qty = 2)
    strategy.exit("XL", "L", limit = 102)`,
            [flat(100), flat(100), [100, 102.5, 99.5, 101], [99, 99, 94, 94.5], flat(94.5)],
        );
        expect(rows(s)).toEqual([['L', 1, 'XL', 102, 2]]);
        expect(s.opentrades.map((t: any) => [t.entry_id, t.entry_price, t.size])).toEqual([['SS', 95, -1]]);
    });

    it('a short placed while flat still opens nothing', async () => {
        const s = await run(
            '',
            `strategy.risk.allow_entry_in(strategy.direction.long)
if bar_index == 1
    strategy.entry("SS", strategy.short, stop = 95)`,
            [flat(100), flat(100), [99, 99, 94, 94.5], flat(94.5)],
        );
        expect(s.closedtrades).toHaveLength(0);
        expect(s.position_size).toBe(0);
    });
});

describe('max_intraday_filled_orders', () => {
    it('a close_all due at the open of the last allowed fill closes its trades before the close-out', async () => {
        // day 2 from bar 4: S1 fills at bar 5 (1st), S2 at bar 6 (2nd); the add S3 and close_all
        // placed on bar 6 fill at the bar 7 open (3rd fill)
        const s = await run(
            ', pyramiding = 5',
            `strategy.risk.max_intraday_filled_orders(3)
if bar_index == 4
    strategy.entry("S1", strategy.short)
if bar_index == 5
    strategy.entry("S2", strategy.short)
if bar_index == 6
    strategy.entry("S3", strategy.short)
    strategy.close_all()`,
            Array.from({ length: 10 }, (_, i) => flat(100 + i)),
        );
        expect(rows(s)).toEqual([
            ['S1', 5, 'Close position order', 107, 7],
            ['S2', 6, 'Close position order', 107, 7],
            ['S3', 7, 'Close Position (Max number of filled orders in one day)', 107, 7],
        ]);
        expect(s.position_size).toBe(0);
    });
});

describe('max_drawdown', () => {
    const decl = ', initial_capital = 600, pyramiding = 2, margin_long = 50, margin_short = 50';
    const body = (limit: number) => `strategy.risk.max_drawdown(${limit}, strategy.percent_of_equity)
if bar_index == 0
    strategy.entry("L", strategy.long, qty = 10)
if bar_index == 3
    strategy.entry("L2", strategy.long, qty = 1)`;
    // long 10 at 100 on 600 at 50 % margin; bar 2 falls to 79 (equity 390 for 395 of margin → call
    // of 1 at 79: realized 579, 3.5 % under 600; equity 390 at the call, 35 %) and closes at 95
    // (534, 11 %)
    const bars: Bar[] = [flat(100), [100, 100.5, 99.5, 100], [99, 99.5, 79, 95], flat(95), flat(95), flat(95)];

    it('after a margin call: checked at the call price, closed at the bar close, trading stops', async () => {
        const s = await run(decl, body(20), bars);
        expect(rows(s)).toEqual([
            ['L', 1, 'Close position order', 79, 2],
            ['L', 1, 'Close Position (Max Drawdown)', 95, 2],
        ]);
        expect(s.opentrades).toHaveLength(0);
    });

    it('a drawdown at the call price under the limit leaves the position open', async () => {
        const s = await run(decl, body(40), bars);
        expect(rows(s)).toEqual([['L', 1, 'Close position order', 79, 2]]);
        expect(s.opentrades.map((t: any) => [t.entry_id, Math.abs(t.size)])).toEqual([['L', 9], ['L2', 1]]);
    });
});

describe('max_intraday_loss', () => {
    it('a reversal booking a profit mid-day is checked against the equity before that profit', async () => {
        // short 10 from 100 (bar 1); the day starts at bar 4 (00:00) with 200 of open profit at 80;
        // reversed at the 81 open of bar 6: +190 booked, equity 10,190 for 10,200 at the day start, but
        // 10,000 before the profit is booked → 200 ≥ 100: closed at that open
        const s = await run(
            '',
            `strategy.risk.max_intraday_loss(100, strategy.cash)
if bar_index == 0
    strategy.entry("S", strategy.short, qty = 10)
if bar_index == 5
    strategy.entry("L", strategy.long, qty = 10)`,
            [flat(100), [100, 100, 90, 90], [90, 90, 85, 85], [85, 85, 80, 80], [80, 80.5, 79.8, 80.5], [80.5, 81.2, 80.3, 81], [81, 81.2, 80.8, 81], flat(81)],
        );
        expect(rows(s)).toEqual([
            ['S', 1, 'L', 81, 6],
            ['L', 6, 'Close Position (Max intraday Loss)', 81, 6],
        ]);
    });

    it('a close order booking a profit mid-day is checked against the booked equity', async () => {
        // long 10 from 100, 100 of open profit at the day start (bar 4); close_all at the 110 open of
        // bar 6 books it; the short placed on bar 6 fills on bar 7 (TV, BTCUSDT 1h, 1 %: trading goes on)
        const s = await run(
            '',
            `strategy.risk.max_intraday_loss(50, strategy.cash)
if bar_index == 0
    strategy.entry("L", strategy.long, qty = 10)
if bar_index == 5
    strategy.close_all()
if bar_index == 6
    strategy.entry("S", strategy.short, qty = 10)`,
            [flat(100), [100, 105, 100, 105], [105, 110, 105, 110], flat(110), flat(110), flat(110), flat(110), flat(110), flat(110)],
        );
        expect(rows(s)).toEqual([['L', 1, 'Close position order', 110, 6]]);
        expect(s.opentrades.map((t: any) => [t.entry_id, t.entry_bar_index])).toEqual([['S', 7]]);
    });

    it('daily bars: the day starts at the open, a gap is not an intraday loss', async () => {
        // long 10 at 100; bar 2 gaps down to 90 (low 89.50: 5 from the open, 105 from the close);
        // bar 3 drops 6 from its open → closed at 84
        const s = await run(
            '',
            `strategy.risk.max_intraday_loss(50, strategy.cash)
if bar_index == 0
    strategy.entry("L", strategy.long, qty = 10)`,
            [flat(100), [100, 100.5, 99.5, 100], [90, 90.5, 89.5, 90], [90, 90.5, 84, 85], flat(85)],
            'D',
        );
        expect(rows(s)).toEqual([['L', 1, 'Close Position (Max intraday Loss)', 84, 3]]);
    });

    it('daily bars: a profitable reversal at the open is not checked against the profit it books', async () => {
        // long 10 from 100 reversed at the 120 open of bar 3 (+200, more than the 100 limit)
        const s = await run(
            '',
            `strategy.risk.max_intraday_loss(100, strategy.cash)
if bar_index == 0
    strategy.entry("L", strategy.long, qty = 10)
if bar_index == 2
    strategy.entry("S", strategy.short, qty = 10)`,
            [flat(100), [100, 110, 100, 110], [110, 120, 110, 120], [120, 120.5, 119.5, 120], flat(120)],
            'D',
        );
        expect(rows(s)).toEqual([['L', 1, 'S', 120, 3]]);
        expect(s.position_size).toBe(-10);
    });
});
