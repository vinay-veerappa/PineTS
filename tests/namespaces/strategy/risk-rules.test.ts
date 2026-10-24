// SPDX-License-Identifier: AGPL-3.0-only
// strategy.risk.* as on TradingView (BINANCE:BTCUSDT 1h / 1D, controlled cases "16"–"20"). A day
// is the bar's date in the exchange timezone.
//   - allow_entry_in(long): a short strategy.entry closes the long under its id and opens nothing;
//     max_position_size(n): an entry is reduced so the position stays within n.
//   - max_intraday_filled_orders(n): the n-th fill of the day is followed by
//     "Close Position (Max number of filled orders in one day)" at that price; orders placed until
//     the end of the day are rejected; trading resumes the next day.
//   - max_drawdown: realized equity's drawdown from its peak, after each fill; then
//     "Close Position (Max Drawdown)" at that fill price and no more trading.
//   - max_intraday_loss: day-start equity minus equity at the bar's adverse extreme; then
//     "Close Position (Max intraday Loss)" at that extreme; trading resumes the next day.
//   - max_cons_loss_days(n): after n days closing below the previous day, a market order sized
//     against the position is queued for the next open and trading stops for good.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close
const H = 3600e3;
const T0 = Date.UTC(2024, 0, 1, 20); // bar 4 opens at midnight UTC

async function run(decl: string, body: string, ohlc: Bar[]) {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: T0 + i * H, closeTime: T0 + (i + 1) * H - 1, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("risk", initial_capital = 10000, default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 0, margin_short = 0${decl})
${body}`;
    const ctx = await new PineTS(provider, 'TEST:X', '60', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return ctx.strategy!;
}
const rows = (s: any) => s.closedtrades.map((t: any) => [t.entry_id, t.entry_bar_index, t.exit_id, t.exit_price, t.exit_bar_index]);
const flat = (p = 100): Bar => [p, p + 0.5, p - 0.5, p];

describe('allow_entry_in and max_position_size', () => {
    it('allow_entry_in(long): a short entry closes the long and opens nothing', async () => {
        const s = await run(
            '',
            `strategy.risk.allow_entry_in(strategy.direction.long)
if bar_index == 0 or bar_index == 4
    strategy.entry("S", strategy.short)
if bar_index == 1
    strategy.entry("L", strategy.long)`,
            Array.from({ length: 8 }, () => flat()),
        );
        expect(rows(s)).toEqual([['L', 2, 'S', 100, 5]]);
        expect(s.position_size).toBe(0);
    });

    it('max_position_size(2): entries are reduced to keep the position within 2', async () => {
        const s = await run(
            ', pyramiding = 5',
            `strategy.risk.max_position_size(2)
if bar_index == 0
    strategy.entry("A", strategy.long)
if bar_index == 1
    strategy.entry("B", strategy.long, qty = 3)
if bar_index == 2
    strategy.entry("C", strategy.long)`,
            Array.from({ length: 5 }, () => flat()),
        );
        expect(s.opentrades.map((t: any) => [t.entry_id, t.size])).toEqual([['A', 1], ['B', 1]]);
    });
});

describe('intraday rules', () => {
    it('max_intraday_filled_orders(2): close after the 2nd fill, reject the rest of the day, resume the next', async () => {
        const s = await run(
            '',
            `strategy.risk.max_intraday_filled_orders(2)
if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 1
    strategy.entry("S", strategy.short)
if bar_index == 2
    strategy.entry("L2", strategy.long)
if bar_index == 4
    strategy.entry("L3", strategy.long)`,
            [flat(100), flat(101), flat(102), flat(103), flat(104), flat(105), flat(106)],
        );
        // fills: L at bar 1 (101), S reversal at bar 2 (102) = 2nd → closed at 102; L2 (placed bar 2)
        // rejected; L3 (placed on the next day, bar 4) fills at bar 5
        expect(rows(s)).toEqual([
            ['L', 1, 'S', 102, 2],
            ['S', 2, 'Close Position (Max number of filled orders in one day)', 102, 2],
        ]);
        expect(s.opentrades.map((t: any) => [t.entry_id, t.entry_bar_index])).toEqual([['L3', 5]]);
    });

    it('max_intraday_loss: closed at the bar extreme where the loss from day start reaches the limit', async () => {
        // long 10 at 100 on bar 5 (the new day starts at bar 4); bar 6 drops to 85 (-150 > 120)
        const s = await run(
            '',
            `strategy.risk.max_intraday_loss(120, strategy.cash)
if bar_index == 4
    strategy.entry("L", strategy.long, qty = 10)`,
            [flat(), flat(), flat(), flat(), flat(), flat(), [100, 100.5, 85, 90], flat(90)],
        );
        expect(rows(s)).toEqual([['L', 5, 'Close Position (Max intraday Loss)', 85, 6]]);
    });
});

describe('strategy-wide rules', () => {
    it('max_drawdown(5%): a realized drawdown over 5% closes the position and stops trading', async () => {
        // long 10 at 100, reversed at 40 → -600 = 6% of 10,000: the new short closes at that fill
        const s = await run(
            '',
            `strategy.risk.max_drawdown(5, strategy.percent_of_equity)
if bar_index == 0
    strategy.entry("L", strategy.long, qty = 10)
if bar_index == 2
    strategy.entry("S", strategy.short, qty = 10)
if bar_index == 4
    strategy.entry("L2", strategy.long)`,
            [flat(), flat(), flat(), flat(40), flat(40), flat(40), flat(40)],
        );
        expect(rows(s)).toEqual([
            ['L', 1, 'S', 40, 3],
            ['S', 3, 'Close Position (Max Drawdown)', 40, 3],
        ]);
        expect(s.opentrades).toHaveLength(0);
    });

    it('max_cons_loss_days(2): after two losing days an order against the position fills at the next open', async () => {
        // days: bars 0-3, 4-27, 28-51; the long from bar 1 loses every day, so the third day opens
        // with the close-out order and nothing trades after it
        const bars: Bar[] = [];
        for (let i = 0; i < 60; i++) bars.push(flat(100 - i * 0.5));
        const s = await run(
            '',
            `strategy.risk.max_cons_loss_days(2)
if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 40
    strategy.entry("L2", strategy.long)`,
            bars,
        );
        expect(rows(s)).toEqual([['L', 1, 'Close Position (Max consecutive loss days)', bars[28][0], 28]]);
        expect(s.opentrades).toHaveLength(0);
    });
});
