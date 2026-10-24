// SPDX-License-Identifier: AGPL-3.0-only
// strategy.* reporting getters as on TradingView (BINANCE:BTCUSDT 1h, Pine v6 unless stated):
//   - opentrades.capital_held: full notional of the open trades (Σ |size| × entry price), whatever
//     the margin (39,999.56 = 0.64828 × 61,701.06 at 20% margin); 0 when flat; na without a margin
//     model (margin 0, or a v5 script that sets no margin);
//   - margin_liquidation_price: na for a long at 100% margin, (equity / qty + entry) / 2 rounded up
//     to the tick for a short (82,017.46 for 1 short at 62,867.99 with 101,166.93 realized equity);
//     na without a margin model;
//   - openprofit_percent: open profit over realized equity (initial capital + net profit);
//   - account_currency: the symbol's currency when strategy() sets none, so convert_to_account /
//     convert_to_symbol return their argument;
//   - closedtrades.profit(i) out of range: 0;
//   - closedtrades.profit_percent and the avg_*_percent summaries: profit over entry notional plus
//     the trade's own entry commission (87.0330 / (4,999.64 + 5) = 1.73905% at 5 per order);
//   - avg_losing_trade: grossloss / losstrades.
// Expected values apply those rules to the Mock bars.

import { describe, it, expect } from 'vitest';
import { PineTS } from '../../../src/PineTS.class';
import { Provider } from '@pinets/marketData/Provider.class';

async function run(src: string) {
    const pineTS = new PineTS(Provider.Mock, 'BTCUSDC', '60', null, Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 15));
    const ctx: any = await pineTS.run(src);
    const v = (t: string): any[] => ctx.plots[t].data.map((d: any) => d.value);
    return { ctx, v };
}
const isNa = (x: any) => x === null || x === undefined || Number.isNaN(x);

const REVERSAL = (decl: string) => `${decl}
f = ta.sma(close, 5)
s = ta.sma(close, 20)
if ta.crossover(f, s)
    strategy.entry("L", strategy.long)
if ta.crossunder(f, s)
    strategy.entry("S", strategy.short)
plot(strategy.position_size, "pos")
plot(strategy.position_avg_price, "avg")
plot(strategy.netprofit, "np")
plot(strategy.openprofit, "op")
plot(strategy.opentrades.capital_held, "cap")
plot(strategy.margin_liquidation_price, "liq")
plot(strategy.openprofit_percent, "opp")
`;

describe('margin getters', () => {
    it('v6 default margin: full notional held; liquidation price for shorts only', async () => {
        const { v } = await run(REVERSAL('//@version=6\nstrategy("t", initial_capital = 100000, default_qty_type = strategy.fixed, default_qty_value = 1)'));
        const [pos, avg, np, cap, liq] = ['pos', 'avg', 'np', 'cap', 'liq'].map(v);
        let longs = 0, shorts = 0;
        for (let i = 0; i < pos.length; i++) {
            if (pos[i] === 0) {
                expect(cap[i]).toBe(0);
                expect(isNa(liq[i])).toBe(true);
            } else {
                expect(cap[i]).toBeCloseTo(Math.abs(pos[i]) * avg[i], 6);
                if (pos[i] > 0) {
                    expect(isNa(liq[i])).toBe(true);
                    longs++;
                } else {
                    const raw = ((100000 + np[i]) / -pos[i] + avg[i]) / 2;
                    expect(liq[i]).toBeCloseTo(Math.ceil(raw / 0.01 - 1e-6) * 0.01, 6);
                    shorts++;
                }
            }
        }
        expect(longs).toBeGreaterThan(20);
        expect(shorts).toBeGreaterThan(20);
    });

    it('margin_long = 20: capital_held is still the full notional', async () => {
        const { v } = await run(REVERSAL('//@version=6\nstrategy("t", initial_capital = 100000, default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 20, margin_short = 20)'));
        const [pos, avg, cap] = ['pos', 'avg', 'cap'].map(v);
        const held = pos.map((p, i) => (p !== 0 ? [cap[i], Math.abs(p) * avg[i]] : null)).filter(Boolean) as number[][];
        expect(held.length).toBeGreaterThan(20);
        for (const [c, n] of held) expect(c).toBeCloseTo(n, 6);
    });

    it('margin 0 and the v5 default have no margin model: both getters are na', async () => {
        for (const decl of [
            '//@version=6\nstrategy("t", initial_capital = 100000, default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 0, margin_short = 0)',
            '//@version=5\nstrategy("t", initial_capital = 100000, default_qty_type = strategy.fixed, default_qty_value = 1)',
        ]) {
            const { v } = await run(REVERSAL(decl));
            const [pos, cap, liq] = ['pos', 'cap', 'liq'].map(v);
            expect(pos.some((p) => p !== 0)).toBe(true);
            expect(cap.every(isNa)).toBe(true);
            expect(liq.every(isNa)).toBe(true);
        }
    });
});

describe('summary getters', () => {
    it('openprofit_percent is open profit over realized equity', async () => {
        const { v } = await run(REVERSAL('//@version=6\nstrategy("t", initial_capital = 100000, default_qty_type = strategy.fixed, default_qty_value = 1)'));
        const [np, op, opp, pos] = ['np', 'op', 'opp', 'pos'].map(v);
        let checked = 0;
        for (let i = 0; i < opp.length; i++) {
            expect(opp[i]).toBeCloseTo((100 * op[i]) / (100000 + np[i]), 9);
            if (pos[i] !== 0 && np[i] !== 0) checked++;
        }
        expect(checked).toBeGreaterThan(20);
    });

    it('account currency defaults to the symbol currency; the converters are then identities', async () => {
        const { ctx, v } = await run(`//@version=6
strategy("t", initial_capital = 100000)
plot(strategy.convert_to_account(100), "acc")
plot(strategy.convert_to_symbol(100), "sym")
plot(strategy.account_currency == syminfo.currency ? 1 : 0, "same")`);
        expect(ctx.strategy.account_currency).toBe(ctx.pine.syminfo.currency);
        expect(v('acc').every((x) => x === 100)).toBe(true);
        expect(v('sym').every((x) => x === 100)).toBe(true);
        expect(v('same').every((x) => x === 1)).toBe(true);
        const usd = await run(`//@version=6
strategy("t", initial_capital = 100000, currency = currency.USD)
plot(0)`);
        expect(usd.ctx.strategy.account_currency).toBe('USD');
    });

    it('trade percents use the entry notional plus the trade\'s entry commission; out-of-range profit is 0', async () => {
        const { ctx, v } = await run(`//@version=6
strategy("t", initial_capital = 100000, default_qty_type = strategy.fixed, default_qty_value = 1, commission_type = strategy.commission.cash_per_order, commission_value = 5)
if bar_index % 10 == 0 and strategy.position_size == 0
    strategy.entry(bar_index % 20 == 0 ? "L" : "S", bar_index % 20 == 0 ? strategy.long : strategy.short)
if bar_index % 10 == 5
    strategy.close_all()
n = strategy.closedtrades - 1
plot(n >= 0 ? strategy.closedtrades.profit_percent(n) : na, "pp")
plot(strategy.closedtrades.profit(strategy.closedtrades + 3), "oor")
plot(strategy.avg_trade_percent, "atp")
plot(strategy.avg_winning_trade_percent, "awp")
plot(strategy.avg_losing_trade_percent, "alp")
plot(strategy.avg_losing_trade, "alt")`);
        const trades: any[] = ctx.strategy.closedtrades;
        expect(trades.length).toBeGreaterThan(20);
        const pct = (t: any) => (100 * t.profit) / (Math.abs(t.size) * t.entry_price + 5);
        const last = trades.at(-1);
        expect(v('pp').at(-1)).toBeCloseTo(pct(last), 9);
        expect(v('oor').every((x) => x === 0)).toBe(true);
        const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
        expect(v('atp').at(-1)).toBeCloseTo(mean(trades.map(pct)), 9);
        expect(v('awp').at(-1)).toBeCloseTo(mean(trades.filter((t) => t.profit > 0).map(pct)), 9);
        expect(v('alp').at(-1)).toBeCloseTo(mean(trades.filter((t) => t.profit < 0).map(pct)), 9);
        expect(v('alt').at(-1)).toBeCloseTo(ctx.strategy.grossloss / ctx.strategy.losstrades, 9);
    });
});
