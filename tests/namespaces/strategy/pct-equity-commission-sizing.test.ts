// SPDX-License-Identifier: AGPL-3.0-only
// Cash and percent-of-equity order sizing with commission and slippage. Rules measured on
// TradingView (BINANCE:BTCUSDT 1h, Pine v6), every entry of each script matching:
//   - percent_of_equity sizes the position AND its entry commission into `pct` of equity:
//       percent commission:  qty = equity × pct / (price × (1 + commission%))
//       cash_per_contract:   qty = equity × pct / (price + commission)
//       cash_per_order:      qty = (equity × pct − commission) / price
//   - `cash` sizing has no commission term;
//   - market and stop orders are sized at the price slippage would give them (close ± slippage
//     ticks), limit orders at their limit, and strategy.default_entry_qty(price) at `price`;
//   - a limit already marketable at the close is sized at the close, without slippage.
// The Mock symbol has syminfo.mincontract 0.00001 and syminfo.mintick 0.01.

import { describe, it, expect } from 'vitest';
import { PineTS } from '../../../src/PineTS.class';
import { Provider } from '@pinets/marketData/Provider.class';

const floorQty = (q: number) => Number((Math.floor((q / 0.00001) * (1 + 1e-10)) * 0.00001).toFixed(5));

async function run(args: string, entry = 'strategy.entry(d == 1 ? "L" : "S", d == 1 ? strategy.long : strategy.short)') {
    const src = `//@version=6
strategy("sizing", ${args})
// enter from flat every 24 bars, alternating direction; flat again 12 bars later
var int d = -1
if bar_index % 24 == 0 and strategy.position_size == 0
    d := -d
    ${entry}
if bar_index % 24 == 12
    strategy.close_all()
plot(strategy.default_entry_qty(close), "deq")
plot(strategy.equity, "eq")
plot(close, "c")
plot(strategy.position_size, "pos")
plot(bar_index, "bi")`;
    const pineTS = new PineTS(Provider.Mock, 'BTCUSDC', '60', null, Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 12));
    const { plots } = await pineTS.run(src);
    const v = (t: string): number[] => plots[t].data.map((x: any) => x.value);
    return { deq: v('deq'), eq: v('eq'), c: v('c'), pos: v('pos'), bi: v('bi') };
}

/** Size of every entry from flat: sized on the signal bar i, filled on bar i + 1. */
function entries(r: Awaited<ReturnType<typeof run>>) {
    const out: { i: number; size: number }[] = [];
    for (let i = 0; i + 1 < r.pos.length; i++) {
        if (r.bi[i] % 24 === 0 && r.pos[i] === 0 && r.pos[i + 1] !== 0) out.push({ i, size: r.pos[i + 1] });
    }
    expect(out.length).toBeGreaterThan(5);
    return out;
}

describe('percent_of_equity sizing includes the entry commission', () => {
    it('percent commission divides the unit cost by (1 + commission%)', async () => {
        const r = await run('initial_capital = 10000, default_qty_type = strategy.percent_of_equity, default_qty_value = 30, commission_type = strategy.commission.percent, commission_value = 0.2');
        for (let i = 0; i < r.deq.length; i++) expect(r.deq[i]).toBe(floorQty((r.eq[i] * 0.3) / (r.c[i] * 1.002)));
        for (const { i, size } of entries(r)) expect(Math.abs(size)).toBe(floorQty((r.eq[i] * 0.3) / (r.c[i] * 1.002)));
    });

    it('cash_per_contract adds the commission to the unit cost', async () => {
        const r = await run('initial_capital = 100000, default_qty_type = strategy.percent_of_equity, default_qty_value = 50, commission_type = strategy.commission.cash_per_contract, commission_value = 25');
        for (let i = 0; i < r.deq.length; i++) expect(r.deq[i]).toBe(floorQty((r.eq[i] * 0.5) / (r.c[i] + 25)));
        for (const { i, size } of entries(r)) expect(Math.abs(size)).toBe(floorQty((r.eq[i] * 0.5) / (r.c[i] + 25)));
    });

    it('cash_per_order takes the commission off the amount', async () => {
        const r = await run('initial_capital = 10000, default_qty_type = strategy.percent_of_equity, default_qty_value = 30, commission_type = strategy.commission.cash_per_order, commission_value = 20');
        for (let i = 0; i < r.deq.length; i++) expect(r.deq[i]).toBe(floorQty((r.eq[i] * 0.3 - 20) / r.c[i]));
        for (const { i, size } of entries(r)) expect(Math.abs(size)).toBe(floorQty((r.eq[i] * 0.3 - 20) / r.c[i]));
    });

    it('cash sizing has no commission term', async () => {
        const r = await run('initial_capital = 100000, default_qty_type = strategy.cash, default_qty_value = 10000, commission_type = strategy.commission.percent, commission_value = 0.5');
        for (const { i, size } of entries(r)) expect(Math.abs(size)).toBe(floorQty(10000 / r.c[i]));
    });
});

describe('orders are sized at the price slippage gives them', () => {
    // slippage 500 ticks = 5.00 on a 0.01 mintick: longs pay more, shorts receive less.
    it('market percent-of-equity orders; default_entry_qty(price) is sized at price itself', async () => {
        const r = await run('initial_capital = 10000, default_qty_type = strategy.percent_of_equity, default_qty_value = 30, slippage = 500');
        for (const { i, size } of entries(r)) expect(Math.abs(size)).toBe(floorQty((r.eq[i] * 0.3) / (r.c[i] + Math.sign(size) * 5)));
        for (let i = 0; i < r.deq.length; i++) expect(r.deq[i]).toBe(floorQty((r.eq[i] * 0.3) / r.c[i]));
    });

    it('market cash orders', async () => {
        const r = await run('initial_capital = 100000, default_qty_type = strategy.cash, default_qty_value = 10000, slippage = 500');
        for (const { i, size } of entries(r)) expect(Math.abs(size)).toBe(floorQty(10000 / (r.c[i] + Math.sign(size) * 5)));
    });

    it('limit orders are sized at the limit, without slippage', async () => {
        const r = await run(
            'initial_capital = 10000, default_qty_type = strategy.percent_of_equity, default_qty_value = 30, slippage = 500',
            'strategy.entry(d == 1 ? "L" : "S", d == 1 ? strategy.long : strategy.short, limit = d == 1 ? close - 1 : close + 1)'
        );
        for (const { i, size } of entries(r)) expect(Math.abs(size)).toBe(floorQty((r.eq[i] * 0.3) / (r.c[i] - Math.sign(size) * 1)));
    });

    it('a limit already marketable at the close is sized at the close, without slippage', async () => {
        // TradingView (BINANCE:BTCUSDT 1h, slippage 500): limits 1000 beyond the close, all 125 trades
        const r = await run(
            'initial_capital = 10000, default_qty_type = strategy.percent_of_equity, default_qty_value = 30, slippage = 500',
            'strategy.entry(d == 1 ? "L" : "S", d == 1 ? strategy.long : strategy.short, limit = d == 1 ? close + 1000 : close - 1000)'
        );
        for (const { i, size } of entries(r)) expect(Math.abs(size)).toBe(floorQty((r.eq[i] * 0.3) / r.c[i]));
    });
});
