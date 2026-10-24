// SPDX-License-Identifier: AGPL-3.0-only
// The strategy broker on the symbol's tick grid, and the order rules that show on split / dividend
// adjusted feeds (TradingView, Pine v6, BATS:AAPL / NVDA / TSLA 1D, mintick 0.01):
//   - bar prices between ticks trade at the nearest tick (AAPL open 40.8125 fills at 40.81), the
//     script still sees the raw price; PineTS.setFillsOnTickGrid(false) trades the raw prices;
//   - market orders are sized at the close on the grid;
//   - a trailing stop's peak follows the raw extremes and its trigger rounds away from the market;
//     a favorable gap moves the peak to the open;
//   - entry and exit limit / stop levels round by the order's side, even when marketable;
//   - a stop and a limit reached at the same point fill stop first;
//   - an exit stop already breached when its trade opens from flat exits at the entry fill;
//   - an exit's trailing leg reached before an opposite entry fills first.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(body: string, ohlc: Bar[], { extra = '', grid = true }: { extra?: string; grid?: boolean } = {}) {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 86_400_000, closeTime: (i + 2) * 86_400_000 - 1, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'stock' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("tick grid", default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 0, margin_short = 0${extra})
${body}`;
    const pineTS = new PineTS(provider, 'TEST:X', '1D', bars.length, undefined, bars[bars.length - 1].closeTime);
    pineTS.setFillsOnTickGrid(grid);
    return pineTS.run(new Indicator(src));
}

describe('broker prices on the tick grid', () => {
    const bars: Bar[] = [
        [40.7, 40.75, 40.65, 40.7],
        [40.8125, 41.3333, 40.6111, 40.7777],
        [40.9, 41, 40.8, 40.9],
    ];
    const body = `if bar_index == 0
    strategy.entry("L", strategy.long)
plot(open, "o")`;

    it('an open between ticks fills at the nearest tick; the script sees the raw open', async () => {
        const ctx = await run(body, bars);
        expect(ctx.strategy!.opentrades[0].entry_price).toBe(40.81);
        expect(ctx.plots['o'].data[1].value).toBe(40.8125);
    });

    it('setFillsOnTickGrid(false) fills at the raw open', async () => {
        const ctx = await run(body, bars, { grid: false });
        expect(ctx.strategy!.opentrades[0].entry_price).toBe(40.8125);
    });

    it('a market order is sized at the close on the grid', async () => {
        // NVDA 1D: 50% of 1,000,000 at a close of 0.5005 (0.50 on the grid) buys 1,000,000 shares
        const ctx = await run(`if bar_index == 0
    strategy.entry("L", strategy.long)`, [[0.5, 0.51, 0.49, 0.5005], [0.5, 0.51, 0.49, 0.5], [0.5, 0.51, 0.49, 0.5]], {
            extra: ', initial_capital = 1000000, default_qty_type = strategy.percent_of_equity, default_qty_value = 50',
        });
        expect(ctx.strategy!.opentrades[0].size).toBe(1000000);
    });
});

describe('trailing stops', () => {
    it("the peak follows the raw extreme and the trigger rounds away from the market", async () => {
        // AAPL 1D: a short's trail peaks at the raw low 71.5325; 37 ticks above is 71.9025, which
        // fires at 71.91 (on the grid low of 71.53 it would be 71.90)
        const ctx = await run(
            `if bar_index == 0
    strategy.entry("S", strategy.short)
strategy.exit("x", "S", trail_points = 100, trail_offset = 37)`,
            [
                [75.3, 75.35, 75.2, 75.25],
                [75.24, 75.3, 75.1, 75.2],
                [75.2, 75.63, 71.5325, 72.02],
                [72, 72.1, 71.9, 72],
            ],
        );
        expect(ctx.strategy!.closedtrades[0].exit_price).toBe(71.91);
        expect(ctx.strategy!.closedtrades[0].exit_bar_index).toBe(2);
    });

    it('a favorable gap moves the peak to the open', async () => {
        // AAPL 1D: a short's trail peaked at 125.60; the next bar opens at 123.76 and rallies, firing
        // at 123.76 + 0.65 = 124.41
        const ctx = await run(
            `if bar_index == 0
    strategy.entry("S", strategy.short)
strategy.exit("x", "S", trail_points = 262, trail_offset = 65)`,
            [
                [129.3, 129.4, 129.1, 129.2],
                [129.2, 129.9, 127.41, 129.71],
                [128.01, 129.72, 125.6, 126],
                [123.76, 126.71, 118.39, 125.86],
            ],
        );
        expect(ctx.strategy!.closedtrades[0].exit_price).toBe(124.41);
        expect(ctx.strategy!.closedtrades[0].exit_bar_index).toBe(3);
    });

    it('a trail armed at a gap open peaks at the raw open', async () => {
        // TSLA 1D: a long from 275.77 arms its trail (200 ticks) when the bar opens at 279.266387
        // (279.27 on the grid) and falls: 100 ticks below the raw open is 278.266, fired at 278.26
        const ctx = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long)
strategy.exit("x", "L", trail_points = 200, trail_offset = 100)`,
            [
                [275.8, 276, 275.5, 275.8],
                [275.77, 276.5, 275.2, 276],
                [279.266387, 283.33305, 277.666389, 281.516385],
                [281.5, 282, 281, 281.5],
            ],
        );
        expect(ctx.strategy!.closedtrades[0].exit_price).toBe(278.26);
        expect(ctx.strategy!.closedtrades[0].exit_bar_index).toBe(2);
    });

    it("an exit's trailing leg reached before an opposite stop entry fills first", async () => {
        // 6E 1D (back-adjusted): a short stop entry queued while flat, then a long; the long's trail
        // fires on the way down from the high before the short's stop further below, and the short
        // then opens from flat
        const ctx = await run(
            `if bar_index == 0
    strategy.entry("S", strategy.short, stop = 98)
if bar_index == 1
    strategy.entry("L", strategy.long)
strategy.exit("x", "L", trail_points = 100, trail_offset = 50)`,
            [
                [100, 100.2, 99.8, 100],
                [100, 100.4, 99.9, 100.3],
                [100, 100.4, 99.9, 100.3],
                [100.5, 102, 97, 97.5],
                [97.5, 97.8, 97.2, 97.5],
            ],
        );
        const s = ctx.strategy!;
        expect(s.closedtrades[0].exit_id).toBe('x');
        expect(s.closedtrades[0].exit_price).toBe(101.5);
        expect(s.opentrades[0].entry_id).toBe('S');
        expect(s.opentrades[0].entry_price).toBe(98);
        expect(s.opentrades[0].size).toBe(-1);
    });
});

describe('limit / stop levels round by the order side', () => {
    it('a marketable buy limit rounds down', async () => {
        // NVDA 1D: a buy limit at 23.487 placed with the close at 23.288 works at 23.48, so the next
        // open (23.49 on the grid) does not fill it; the low does
        const ctx = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long, limit = 23.487)`,
            [
                [23.6, 24.125, 23.241, 23.288],
                [23.487, 24.2, 23.4235, 24.181],
                [24.2, 24.3, 24.1, 24.2],
            ],
        );
        expect(ctx.strategy!.opentrades[0].entry_price).toBe(23.48);
    });

    it("a short's exit stop rounds up whatever the close", async () => {
        // AAPL 1D: a short's stop at 53.4925 placed with the close at 53.5425 works at 53.50
        const ctx = await run(
            `if bar_index == 0
    strategy.entry("S", strategy.short)
if bar_index == 1
    strategy.exit("x", "S", stop = 53.4925)`,
            [
                [53.3, 53.35, 53.25, 53.3],
                [53.3, 53.55, 53.25, 53.5425],
                [53.4, 53.49, 53.3, 53.45],
                [53.45, 53.5, 53.4, 53.48],
            ],
        );
        expect(ctx.strategy!.closedtrades[0].exit_price).toBe(53.5);
        expect(ctx.strategy!.closedtrades[0].exit_bar_index).toBe(3);
    });
});

describe('same-point fills', () => {
    it('a stop and a limit filling at the same open: the stop first, whatever the placement order', async () => {
        // AAPL / NVDA / TSLA 1D, ~1,600 gaps: a sell limit placed before a buy stop, both at the close,
        // fill buy stop first on a gap up; the sell limit then closes it
        const ctx = await run(
            `if bar_index == 0
    strategy.entry("SL", strategy.short, limit = close)
    strategy.entry("BS", strategy.long, stop = close)`,
            [
                [100, 100.5, 99.5, 100],
                [101, 102, 100.8, 101.5],
                [101.5, 101.6, 101.4, 101.5],
            ],
        );
        const s = ctx.strategy!;
        expect(s.closedtrades[0].entry_id).toBe('BS');
        expect(s.closedtrades[0].exit_id).toBe('SL');
        expect(s.opentrades).toHaveLength(0);
    });

    it('a market entry fills at the open before an older stop entry the bar opens past', async () => {
        // AAPL / NVDA / TSLA 1D: a short stop entry queued earlier and a market long queued on the
        // previous bar, the bar gapping below the stop: the long fills first, then the short (queued
        // flat, quantity 1) closes it
        const ctx = await run(
            `if bar_index == 0
    strategy.entry("S", strategy.short, stop = 99)
if bar_index == 1
    strategy.entry("L", strategy.long)`,
            [
                [100, 100.5, 99.5, 100],
                [100, 100.5, 99.5, 100],
                [98, 98.5, 97.5, 98],
                [98, 98.5, 97.5, 98],
            ],
        );
        const s = ctx.strategy!;
        expect(s.closedtrades[0].entry_id).toBe('L');
        expect(s.closedtrades[0].exit_id).toBe('S');
        expect(s.opentrades).toHaveLength(0);
    });

    it('an exit stop already breached when a short opens from flat exits at the entry fill', async () => {
        // BINANCE:BTCUSDT 1h / AAPL / NVDA 1D: market, stop and limit shorts with their exit stop below
        // the fill all exit at the fill (100 / 100 each)
        const ctx = await run(
            `if bar_index == 0
    strategy.entry("S", strategy.short)
    strategy.exit("x", "S", stop = close * 0.97)`,
            [
                [100, 100.5, 99.5, 100],
                [100.2, 101, 96, 96.5],
                [96.5, 97, 96, 96.5],
            ],
        );
        const t = ctx.strategy!.closedtrades[0];
        expect(t.entry_price).toBe(100.2);
        expect(t.exit_price).toBe(100.2);
        expect(t.exit_bar_index).toBe(1);
    });
});
