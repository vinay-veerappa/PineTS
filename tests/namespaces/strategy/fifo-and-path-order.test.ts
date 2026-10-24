// SPDX-License-Identifier: AGPL-3.0-only
// Broker-emulator rules from #316 items 2 and 4, measured on TradingView (BINANCE:BTCUSDT 1h, Pine v6):
//   - under close_entries_rule = "FIFO" (the default) an exit of one entry closes the OLDEST open
//     entries first, whatever their id: with A 0.2 then B 0.4 open, B's take-profit (0.4) books
//     A 0.2 and B 0.2, and strategy.close("C") books A. Under "ANY" an exit closes its own entry.
//   - one exit fill books one row per entry it closes, even when that entry's quantity is spread
//     over several lots (strategy.close_all after the FIFO pairing above books B 0.5 once);
//   - strategy.position_entry_name is the entry of the oldest open quantity;
//   - a limit / stop entry against the open position fills where the bar's path (open → nearer
//     extreme → farther extreme → close) reaches it. When a stop / limit exit of that position is
//     reached first on the path, the exit fills first and the entry then fills with the quantity
//     it was queued with (a reversal queued against 1 long opens 2 short).
// Expected values apply those rules to the Mock bars.

import { describe, it, expect } from 'vitest';
import { PineTS } from '../../../src/PineTS.class';
import { Provider } from '@pinets/marketData/Provider.class';

async function run(src: string) {
    const pineTS = new PineTS(Provider.Mock, 'BTCUSDC', '60', null, Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1));
    const ctx: any = await pineTS.run(src);
    return {
        ctx,
        trades: ctx.strategy.closedtrades as any[],
        open: ctx.data.open.data as number[],
        high: ctx.data.high.data as number[],
        low: ctx.data.low.data as number[],
        close: ctx.data.close.data as number[],
    };
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

describe('close_entries_rule = "FIFO" (#316 item 4)', () => {
    const PYRAMID = (rule: string) => `//@version=6
strategy("fifo", overlay = true, initial_capital = 1000000, pyramiding = 2, ${rule}default_qty_type = strategy.fixed, default_qty_value = 1)
k = bar_index % 60
if k == 0 and strategy.position_size == 0
    strategy.entry("A", strategy.long, qty = 0.2)
    strategy.exit("XA", "A", limit = close * 1.30)
if k == 5
    strategy.entry("B", strategy.long, qty = 0.4)
    strategy.exit("XB", "B", limit = close * 1.005, stop = close * 0.99)
if k == 50
    strategy.close_all(comment = "END")
`;

    it("an exit of the newer entry books the older entry first", async () => {
        const { trades } = await run(PYRAMID(''));
        const xb = trades.filter((t) => t.exit_id === 'XB');
        expect(xb.length).toBeGreaterThan(5);
        const byBar = new Map<number, any[]>();
        for (const t of xb) byBar.set(t.exit_bar_index, [...(byBar.get(t.exit_bar_index) ?? []), t]);
        for (const [bar, rows] of byBar) {
            expect(rows.map((t) => [t.entry_id, Number(t.size.toFixed(5))])).toEqual([
                ['A', 0.2],
                ['B', 0.2],
            ]);
            // what XB left open is B's remaining 0.2, closed by close_all at the end of the round
            const end = trades.find((t) => t.exit_comment === 'END' && t.exit_bar_index > bar);
            if (end) expect([end.entry_id, Number(end.size.toFixed(5))]).toEqual(['B', 0.2]);
        }
    });

    it('close_entries_rule = "ANY": an exit closes its own entry', async () => {
        const { trades } = await run(PYRAMID('close_entries_rule = "ANY", '));
        const xb = trades.filter((t) => t.exit_id === 'XB');
        expect(xb.length).toBeGreaterThan(5);
        for (const t of xb) expect([t.entry_id, Number(t.size.toFixed(5))]).toEqual(['B', 0.4]);
    });

    it('strategy.close(id) books the oldest entries, one row per entry, and position_entry_name follows', async () => {
        const { trades, ctx } = await run(`//@version=6
strategy("fifo close", overlay = true, initial_capital = 1000000, pyramiding = 3, default_qty_type = strategy.fixed, default_qty_value = 1)
k = bar_index % 40
if k == 0 and strategy.position_size == 0
    strategy.entry("A", strategy.long, qty = 0.3)
if k == 3
    strategy.entry("B", strategy.long, qty = 0.5)
if k == 6
    strategy.entry("C", strategy.long, qty = 0.1)
if k == 10
    strategy.close("C", comment = "cC")
if k == 15
    strategy.close("B", comment = "cB", qty = 0.2)
if k == 20
    strategy.close_all(comment = "END")
plot(k == 12 ? (strategy.position_entry_name == "A" ? 1 : 0) : na, "nameA")
plot(k == 17 ? (strategy.position_entry_name == "B" ? 1 : 0) : na, "nameB")`);
        const rounds = trades.length / 4;
        expect(rounds).toBeGreaterThan(5);
        for (let r = 0; r < Math.floor(rounds); r++) {
            const [c, b, end1, end2] = trades.slice(r * 4, r * 4 + 4);
            expect([c.entry_id, Number(c.size.toFixed(5)), c.exit_comment]).toEqual(['A', 0.1, 'cC']);
            expect([b.entry_id, Number(b.size.toFixed(5)), b.exit_comment]).toEqual(['A', 0.2, 'cB']);
            expect([end1.entry_id, Number(end1.size.toFixed(5)), end1.exit_comment]).toEqual(['B', 0.5, 'END']);
            expect([end2.entry_id, Number(end2.size.toFixed(5)), end2.exit_comment]).toEqual(['C', 0.1, 'END']);
        }
        const names = (t: string) => ctx.plots[t].data.map((d: any) => d.value).filter((v: any) => v === 0 || v === 1);
        expect(names('nameA').length).toBeGreaterThan(5);
        expect(names('nameA').every((v: number) => v === 1)).toBe(true);
        expect(names('nameB').every((v: number) => v === 1)).toBe(true);
    });
});

describe('an exit reached before a reversing limit entry on the bar path (#316 item 2)', () => {
    it('fills the exit first; the entry then opens the quantity it was queued with', async () => {
        const { trades, open, high, low } = await run(`//@version=6
strategy("path", overlay = true, initial_capital = 1000000, default_qty_type = strategy.fixed, default_qty_value = 1)
k = bar_index % 30
if k == 0 and strategy.position_size == 0
    strategy.entry("L", strategy.long)
if k == 1
    strategy.entry("S", strategy.short, limit = math.round_to_mintick(close * 1.004))
if strategy.position_size > 0
    strategy.exit("xl", "L", stop = math.round_to_mintick(strategy.position_avg_price * 0.997))
if k == 25
    strategy.cancel_all()
    strategy.close_all(comment = "END")`);
        let stopFirst = 0;
        let limitFirst = 0;
        for (let i = 0; i < trades.length; i++) {
            const t = trades[i];
            if (t.entry_id !== 'L' || t.exit_comment === 'END') continue;
            const b = t.exit_bar_index;
            const stop = Math.round(t.entry_price * 0.997 * 100) / 100;
            const next = trades[i + 1];
            if (t.exit_id === 'xl') {
                expect(t.exit_price).toBeCloseTo(Math.min(stop, open[b]), 6);
                // the short filled on the same bar, after the stop: 2 contracts, as queued
                if (next && next.entry_id === 'S' && next.entry_bar_index === b) {
                    expect(Math.abs(next.size)).toBe(2);
                    // the stop was first on the path: the bar opened past it, or went down first
                    expect(open[b] <= stop || Math.abs(high[b] - open[b]) > Math.abs(open[b] - low[b])).toBe(true);
                    stopFirst++;
                }
            } else {
                expect(t.exit_id).toBe('S');
                if (low[b] <= stop) {
                    // both reached on this bar: the path went up first
                    expect(Math.abs(high[b] - open[b]) <= Math.abs(open[b] - low[b])).toBe(true);
                    limitFirst++;
                }
            }
        }
        expect(stopFirst + limitFirst).toBeGreaterThan(0);
        expect(stopFirst).toBeGreaterThan(0);
    });
});
