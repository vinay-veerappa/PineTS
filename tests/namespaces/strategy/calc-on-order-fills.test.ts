// SPDX-License-Identifier: AGPL-3.0-only
// strategy(calc_on_order_fills = true) as on TradingView (BINANCE:BTCUSDT 1h, Pine v6, probes
// "cof01"–"cof07" and controlled case "25"). On a historical bar the broker walks the path open →
// nearer extreme → farther extreme → close; a fill between two points belongs to the later one.
// After the points with fills (other than the close) the script runs again, on the complete bar,
// with the broker state at that point: its market orders fill at that point's price, its limit /
// stop orders work on the rest of the path. `var` is rolled back between the runs of a bar; plots
// come from the bar's last run.

import { describe, it, expect, vi } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(decl: string, body: string, ohlc: Bar[]) {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 60000, closeTime: (i + 2) * 60000 - 1, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("cof", default_qty_type = strategy.fixed, default_qty_value = 1, pyramiding = 5, margin_long = 0, margin_short = 0${decl})
${body}`;
    return new PineTS(provider, 'TEST:X', '1', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
}
const COF = ', calc_on_order_fills = true';
const flat = (p = 100): Bar => [p, p + 0.5, p - 0.5, p];
const entries = (s: any) => [...s.closedtrades, ...s.opentrades].map((t: any) => [t.entry_id, t.entry_price, t.entry_bar_index]);

describe('calc_on_order_fills', () => {
    it('after a fill at the open, a market order placed by the script fills at that open on the same bar', async () => {
        const body = `if bar_index == 0
    strategy.entry("E", strategy.long)
if strategy.position_size > 0 and strategy.opentrades == 1
    strategy.order("O", strategy.long)`;
        const bars: Bar[] = [flat(), [101, 101.2, 99, 100], flat(), flat()];
        expect(entries((await run(COF, body, bars)).strategy)).toEqual([['E', 101, 1], ['O', 101, 1]]);
        // without the setting the order waits for the next bar
        expect(entries((await run('', body, bars)).strategy)).toEqual([['E', 101, 1], ['O', 100, 2]]);
    });

    it('after a limit fill inside a segment, a close fills at the point ending that segment', async () => {
        // bar 1: open 100, high 100.2 first, then down to 98 (the buy limit at 99 fills on the way),
        // close 98.5: the close placed after the fill fills at the low, 98
        const s = (
            await run(
                COF,
                `if bar_index == 0
    strategy.entry("E", strategy.long, limit = 99)
if strategy.position_size > 0
    strategy.close("E")`,
                [flat(), [100, 100.2, 98, 98.5], flat(98.5)],
            )
        ).strategy!;
        expect(s.closedtrades.map((t: any) => [t.entry_price, t.exit_price, t.exit_bar_index])).toEqual([[99, 98, 1]]);
    });

    it('a limit placed after a fill and not reached on the rest of the bar stays pending', async () => {
        // the entry fills at bar 1's open (100); the limit at 97 placed then is not reached on bar 1
        // (low 98.5) and fills on bar 2
        const s = (
            await run(
                COF,
                `if bar_index == 0
    strategy.entry("E", strategy.long)
if strategy.position_size > 0 and strategy.opentrades == 1
    strategy.order("O", strategy.long, limit = 97)`,
                [flat(), [100, 100.4, 98.5, 99], [99, 99.2, 96.5, 97.5], flat(97.5)],
            )
        ).strategy!;
        expect(entries(s)).toEqual([['E', 100, 1], ['O', 97, 2]]);
    });

    it('var is rolled back between the runs of a bar and plots come from its last run', async () => {
        const ctx = await run(
            COF,
            `var int n = 0
n += 1
plot(n, "n")
if bar_index % 2 == 0
    strategy.entry("E", strategy.long)
if bar_index % 2 == 1
    strategy.close_all()`,
            [flat(), flat(101), flat(102), flat(103), flat(104), flat(105)],
        );
        expect((ctx.plots['n'].data as any[]).map((p) => p.value)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('varip is not rolled back between the runs of a bar', async () => {
        // TradingView, BINANCE:BTCUSDT 1h (market entry then a strategy.order on its fill, first 13 bars): bar 1 runs three times (fill at
        // the open, the in-fill order's fill, the close) and bar 11 twice. `var int n` is rolled back,
        // `varip int m` keeps counting every run.
        const tvBars: Bar[] = [
            [63865.84, 63915, 63742, 63766.8], [63766.8, 63786.49, 63587.99, 63782.64], [63782.65, 63818.16, 63586, 63651.19],
            [63651.2, 63660.76, 63350, 63484.3], [63484.31, 63710, 63450, 63697.76], [63697.76, 63850, 63566, 63724],
            [63723.99, 63999, 63686, 63859.45], [63859.46, 63940.08, 63420, 63420.01], [63420.01, 63568.97, 62802.27, 63160.13],
            [63160.13, 63294.61, 63074.44, 63144.38], [63144.37, 63369.63, 63105.44, 63310], [63310, 63519.39, 63310, 63407.99],
            [63408, 63474.34, 63368, 63415.55],
        ];
        // [bar_index, n, m] per run, as logged on TradingView
        const tvRuns = [
            [0, 1, 1], [1, 2, 2], [1, 2, 3], [1, 2, 4], [2, 3, 5], [3, 4, 6], [4, 5, 7], [5, 6, 8], [6, 7, 9], [7, 8, 10],
            [8, 9, 11], [9, 10, 12], [10, 11, 13], [11, 12, 14], [11, 12, 15], [12, 13, 16],
        ];
        const lines: string[] = [];
        const spy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => {
            lines.push(a.join(' '));
        });
        let ctx: any;
        try {
            ctx = await run(
                COF,
                `var int n = 0
varip int m = 0
n += 1
m += 1
log.info("X|{0}|{1}|{2}", bar_index, n, m)
plot(m, "m")
var int filledAt = -1
if bar_index % 40 == 0
    strategy.entry("E", strategy.long)
if strategy.position_size > 0 and filledAt != bar_index and strategy.opentrades == 1
    filledAt := bar_index
    strategy.order("O", strategy.long, comment = "in-fill")
if bar_index % 40 == 10
    strategy.close_all()`,
                tvBars,
            );
        } finally {
            spy.mockRestore();
        }
        const runs = lines
            .map((l) => l.match(/X\|(\d+)\|(\d+)\|(\d+)/))
            .filter(Boolean)
            .map((m) => [+m![1], +m![2], +m![3]]);
        expect(runs).toEqual(tvRuns);
        // plots come from each bar's last run
        expect((ctx.plots['m'].data as any[]).map((p) => p.value)).toEqual([1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16]);
    });
});

describe('strategy.order', () => {
    it('an order with the id of a pending order from an earlier bar modifies it', async () => {
        const s = (
            await run(
                '',
                `strategy.order("O", strategy.long, limit = 95)`,
                [flat(), flat(), flat(), [100, 100.2, 94, 95]],
            )
        ).strategy!;
        expect(s.opentrades.map((t: any) => [t.entry_id, t.entry_price])).toEqual([['O', 95]]);
    });

    it('limit / stop levels snap to the tick grid away from the market', async () => {
        const s = (
            await run(
                '',
                `if bar_index == 0
    strategy.order("O", strategy.long, limit = 99.123)`,
                [flat(), [100, 100.2, 99, 99.5], flat()],
            )
        ).strategy!;
        expect(s.opentrades.map((t: any) => t.entry_price)).toEqual([99.12]);
    });
});
