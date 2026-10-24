// SPDX-License-Identifier: AGPL-3.0-only
// strategy.close / close_all queued together with an entry on the same bar (#316 item 1). The rules
// were measured on TradingView (BINANCE:BTCUSDT 1h, Pine v6, ten scripts of this shape):
//   - a market close queued BEFORE an entry fills first, at the next open, under the close's id and
//     comment; the entry then opens just its own quantity (a partial close leaves only the rest to
//     reverse, booked as a second trade under the entry's id);
//   - an entry queued BEFORE the close fills first: it reverses the position and the close never fills;
//   - `immediately = true` and `process_orders_on_close` fill the close at the signal bar's close.
// Expected values below apply those rules to the Mock bars.

import { describe, it, expect } from 'vitest';
import { PineTS } from '../../../src/PineTS.class';
import { Provider } from '@pinets/marketData/Provider.class';

async function run(body: string, args = 'initial_capital = 1000000, default_qty_type = strategy.fixed, default_qty_value = 1') {
    const src = `//@version=6
strategy("close before entry", overlay = true, ${args})
sig = bar_index > 50 and bar_index % 12 == 0
var int dir = 0
if sig
    dir := dir == 1 ? -1 : 1
${body}`;
    const pineTS = new PineTS(Provider.Mock, 'BTCUSDC', '60', null, Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 12));
    const ctx: any = await pineTS.run(src);
    const open: number[] = ctx.data.open.data;
    const close: number[] = ctx.data.close.data;
    const trades: any[] = ctx.strategy.closedtrades;
    expect(trades.length).toBeGreaterThan(10);
    return { open, close, trades, opentrades: ctx.strategy.opentrades as any[] };
}

const REVERSE = 'strategy.entry(dir == 1 ? "L" : "S", dir == 1 ? strategy.long : strategy.short)';
const CLOSE_OPEN_SIDE = (extra: string) => `strategy.close(strategy.position_size > 0 ? "L" : "S"${extra})`;

describe('strategy.close queued before a reversing entry (#316)', () => {
    it('market reversal: the close fills first at the open under its id, the entry opens its own qty', async () => {
        const { open, trades, opentrades } = await run(`if sig
    if strategy.position_size != 0
        ${CLOSE_OPEN_SIDE(', comment = "REV"')}
    ${REVERSE}`);
        for (const t of trades) {
            expect(t.exit_id).toBe(`Close entry(s) order ${t.entry_id}`);
            expect(t.exit_comment).toBe('REV');
            expect(t.exit_price).toBe(open[t.exit_bar_index]);
            expect(t.exit_bar_index % 12).toBe(1);
            expect(Math.abs(t.size)).toBe(1);
        }
        expect(opentrades.map((t) => Math.abs(t.size))).toEqual([1]);
    });

    it('limit reversal: the close exits at the open; the limit entry opens a fresh position later', async () => {
        const { open, trades } = await run(`atr = ta.atr(14)
if sig
    strategy.cancel(dir == 1 ? "S" : "L")
    if strategy.position_size != 0
        ${CLOSE_OPEN_SIDE(', comment = "REV"')}
    strategy.entry(dir == 1 ? "L" : "S", dir == 1 ? strategy.long : strategy.short, limit = dir == 1 ? close - 0.1 * atr : close + 0.1 * atr)`);
        for (const t of trades) {
            expect(t.exit_id).toBe(`Close entry(s) order ${t.entry_id}`);
            expect(t.exit_comment).toBe('REV');
            expect(t.exit_price).toBe(open[t.exit_bar_index]);
            expect(Math.abs(t.size)).toBe(1);
        }
    });

    it('partial close: the closed part is booked first, the entry reverses only the rest', async () => {
        const { trades } = await run(
            `if sig
    if strategy.position_size != 0
        ${CLOSE_OPEN_SIDE(', comment = "PART", qty_percent = 25')}
    ${REVERSE}`,
            'initial_capital = 1000000, default_qty_type = strategy.fixed, default_qty_value = 4'
        );
        // The first reversal has nothing to close partially (flat before it).
        const byExitBar = new Map<number, any[]>();
        for (const t of trades) byExitBar.set(t.exit_bar_index, [...(byExitBar.get(t.exit_bar_index) ?? []), t]);
        let pairs = 0;
        for (const group of byExitBar.values()) {
            if (group.length !== 2) continue;
            pairs++;
            const [part, rest] = group;
            expect(part.exit_id).toBe(`Close entry(s) order ${part.entry_id}`);
            expect(part.exit_comment).toBe('PART');
            expect(Math.abs(part.size)).toBe(1);
            expect(rest.exit_id).toBe(rest.entry_id === 'L' ? 'S' : 'L');
            expect(Math.abs(rest.size)).toBe(3);
        }
        expect(pairs).toBeGreaterThan(5);
    });

    it('close_all: exits under "Close position order" before the reversal', async () => {
        const { open, trades } = await run(`if sig
    strategy.close_all(comment = "ALL")
    ${REVERSE}`);
        for (const t of trades) {
            expect(t.exit_id).toBe('Close position order');
            expect(t.exit_comment).toBe('ALL');
            expect(t.exit_price).toBe(open[t.exit_bar_index]);
            expect(Math.abs(t.size)).toBe(1);
        }
    });

    it('a close followed by a same-direction entry exits and re-enters at the same open', async () => {
        const { open, trades } = await run(`if bar_index == 40
    strategy.entry("L", strategy.long)
if sig
    strategy.close("L", comment = "OUT")
    strategy.entry("L", strategy.long, comment = "IN")`);
        for (const t of trades) {
            expect(t.exit_id).toBe('Close entry(s) order L');
            expect(t.exit_comment).toBe('OUT');
            expect(Math.abs(t.size)).toBe(1);
        }
        // each re-entry fills at the same open its predecessor exited at
        for (let k = 1; k < trades.length; k++) {
            expect(trades[k].entry_comment).toBe('IN');
            expect(trades[k].entry_bar_index).toBe(trades[k - 1].exit_bar_index);
            expect(trades[k].entry_price).toBe(open[trades[k].entry_bar_index]);
        }
    });

    it('under pyramiding, close(id) closes that entry and the reversal closes the rest at the same open', async () => {
        const { trades } = await run(
            `phase = bar_index % 24
if bar_index > 50 and phase == 0
    strategy.entry("L1", strategy.long)
if bar_index > 50 and phase == 3
    strategy.entry("L2", strategy.long)
if bar_index > 50 and phase == 12
    strategy.close("L1", comment = "X1")
    strategy.entry("S", strategy.short)
if bar_index > 50 and phase == 18
    strategy.close_all(comment = "FLAT")`,
            'initial_capital = 1000000, default_qty_type = strategy.fixed, default_qty_value = 1, pyramiding = 2'
        );
        const l1 = trades.filter((t) => t.entry_id === 'L1');
        const l2 = trades.filter((t) => t.entry_id === 'L2');
        const s = trades.filter((t) => t.entry_id === 'S');
        expect(l1.length).toBeGreaterThan(5);
        for (const t of l1) expect([t.exit_id, t.exit_comment]).toEqual(['Close entry(s) order L1', 'X1']);
        for (const t of l2) expect(t.exit_id).toBe('S');
        for (const t of s) expect([t.exit_id, Math.abs(t.size)]).toEqual(['Close position order', 1]);
        // every L1 close shares its open with the reversal that closes the L2 lot
        for (const t of l1) expect(l2.some((u) => u.exit_bar_index === t.exit_bar_index)).toBe(true);
    });
});

describe('orders that are not reordered', () => {
    it('an entry queued before the close reverses the position; the close does not fill', async () => {
        const { open, trades } = await run(`if sig
    ${REVERSE}
    if strategy.position_size != 0
        ${CLOSE_OPEN_SIDE(', comment = "LATE"')}`);
        for (const t of trades) {
            expect(t.exit_id).toBe(t.entry_id === 'L' ? 'S' : 'L');
            expect(t.exit_comment).not.toBe('LATE');
            expect(t.exit_price).toBe(open[t.exit_bar_index]);
            expect(Math.abs(t.size)).toBe(1);
        }
    });

    // TradingView, case "12 close immediately" (BINANCE:BTCUSDT 1h): close_all(immediately = true)
    // queued after an opposite strategy.entry on the same bar does not fill at that close; the
    // short is closed by the long entry at the next open, under the entry's id.
    it('an entry queued before close(immediately = true) reverses the position; the close does not fill', async () => {
        const { open, trades } = await run(`if sig
    ${REVERSE}
    if strategy.position_size != 0
        strategy.close_all(comment = "NOW", immediately = true)`);
        for (const t of trades) {
            expect(t.exit_id).toBe(t.entry_id === 'L' ? 'S' : 'L');
            expect(t.exit_comment).not.toBe('NOW');
            expect(t.exit_bar_index % 12).toBe(1);
            expect(t.exit_price).toBe(open[t.exit_bar_index]);
            expect(Math.abs(t.size)).toBe(1);
        }
    });

    it('close(immediately = true) fills at the signal close; the entry opens its own qty at the next open', async () => {
        const { close, open, trades, opentrades } = await run(`if sig
    if strategy.position_size != 0
        ${CLOSE_OPEN_SIDE(', comment = "NOW", immediately = true')}
    ${REVERSE}`);
        for (const t of trades) {
            expect(t.exit_comment).toBe('NOW');
            expect(t.exit_bar_index % 12).toBe(0);
            expect(t.exit_price).toBe(close[t.exit_bar_index]);
            expect(t.entry_price).toBe(open[t.entry_bar_index]);
            expect(Math.abs(t.size)).toBe(1);
        }
        for (const t of opentrades) expect(Math.abs(t.size)).toBe(1);
    });

    it('process_orders_on_close: the close and the entry both fill at the signal close, the entry with its own qty', async () => {
        const { close, trades } = await run(
            `if sig
    if strategy.position_size != 0
        ${CLOSE_OPEN_SIDE(', comment = "REV"')}
    ${REVERSE}`,
            'initial_capital = 1000000, default_qty_type = strategy.fixed, default_qty_value = 1, process_orders_on_close = true'
        );
        for (const t of trades) {
            expect(t.exit_id).toBe(`Close entry(s) order ${t.entry_id}`);
            expect(t.exit_bar_index % 12).toBe(0);
            expect(t.exit_price).toBe(close[t.exit_bar_index]);
            expect(Math.abs(t.size)).toBe(1);
        }
    });
});
