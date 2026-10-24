// SPDX-License-Identifier: AGPL-3.0-only
// Order arguments TradingView rejects, and the ones it accepts (Pine v6, BINANCE:BTCUSDT 1h / BATS:AAPL 1D /
// CME_MINI_DL:ES1! 1D). Runtime errors stop the script with these messages (TradingView prefixes them with
// "Error on bar N: "):
//   - RE10024: a negative `qty` in strategy.entry / strategy.order, also when pyramiding would have blocked
//     the order; `qty = 0` places nothing;
//   - RE10025: `qty_percent` outside (0, 100] in strategy.exit, and outside [0, 100] in strategy.close (whose
//     message names strategy.exit); not checked when `qty` is given, nor when there is nothing to close;
//   - RE10028: re-placing a pending strategy.entry / strategy.order id in the other direction (on the same
//     bar or a later one, across both commands); the message names the command of the pending order.
// Compile error CE10042 (strategy.exit without a price leg) is raised when the call runs.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator, PineRuntimeError } from '../../../src';

function run(body: string, n = 12, extra = '') {
    const bars = Array.from({ length: n }, (_, i) => {
        const c = 100 + Math.sin(i) * 2;
        return { openTime: (i + 1) * 3600000, closeTime: (i + 2) * 3600000 - 1, open: c - 0.3, high: c + 1, low: c - 1, close: c, volume: 1 };
    });
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("validation", initial_capital = 10000000, default_qty_type = strategy.fixed, default_qty_value = 1${extra})
${body}`;
    return new PineTS(provider, 'TEST:X', '60', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src)).then((ctx) => ctx.strategy!);
}

const QTY_MSG = (v: string, fn: string) => `Invalid \`qty\` value (${v}) in the \`${fn}()\` call. Use a positive number less or equal to 1000000000000.`;
const PCT_MSG = (v: string) => `Invalid \`qty_percent\` value (${v}) in the \`strategy.exit()\` call. Use a positive value less than or equal to 100 for this parameter.`;
const DIR_MSG = (fn: string, id: string, from: string, to: string) =>
    `The '${fn}' call already generated an order with the '${id}' ID in the '${from}' direction, which cannot be changed to '${to}'. Cancel the existing '${id}' order and create a new order in the desired direction, or specify a different 'id' for the '${to}' order.`;

describe('qty validation (RE10024)', () => {
    it('strategy.entry with a negative qty stops the script', async () => {
        const p = run(`negq = bar_index >= 0 ? -2.0 : 1.0
if bar_index == 0
    strategy.entry("N", strategy.long, qty = negq)`);
        await expect(p).rejects.toBeInstanceOf(PineRuntimeError);
        await expect(p).rejects.toThrow(QTY_MSG('-2', 'strategy.entry'));
    });

    it('also when pyramiding would have blocked the entry', async () => {
        const p = run(`negq = bar_index >= 0 ? -2.0 : 1.0
if bar_index == 3
    strategy.entry("P", strategy.long, qty = 1)
if bar_index == 5
    strategy.entry("P", strategy.long, qty = negq)`);
        await expect(p).rejects.toThrow(QTY_MSG('-2', 'strategy.entry'));
    });

    it('strategy.order with a negative qty stops the script', async () => {
        const p = run(`negq = bar_index >= 0 ? -1.0 : 1.0
if bar_index == 2
    strategy.order("N", strategy.short, qty = negq)`);
        await expect(p).rejects.toThrow(QTY_MSG('-1', 'strategy.order'));
    });

    it('qty = 0 places nothing and is not an error', async () => {
        const s = await run(`if bar_index == 0
    strategy.entry("Z", strategy.long, qty = 0)`);
        expect(s.opentrades.length + s.closedtrades.length).toBe(0);
    });
});

describe('qty_percent validation (RE10025)', () => {
    it('strategy.exit with qty_percent 150 stops the script', async () => {
        const p = run(`pct = bar_index >= 0 ? 150.0 : 50.0
if bar_index == 0
    strategy.entry("L", strategy.long, qty = 2)
if bar_index == 1
    strategy.exit("p", "L", qty_percent = pct, profit = 300, loss = 300)`);
        await expect(p).rejects.toThrow(PCT_MSG('150'));
    });

    it('strategy.exit with qty_percent 0 stops the script', async () => {
        const p = run(`if bar_index == 0
    strategy.entry("L", strategy.long, qty = 2)
if bar_index == 1
    strategy.exit("p0", "L", qty_percent = 0, profit = 300, loss = 300)`);
        await expect(p).rejects.toThrow(PCT_MSG('0'));
    });

    it('strategy.exit does not check qty_percent when qty is given', async () => {
        const s = await run(`pct = bar_index >= 0 ? 150.0 : 50.0
if bar_index == 0
    strategy.entry("L", strategy.long, qty = 2)
if bar_index == 1
    strategy.exit("p", "L", qty = 1, qty_percent = pct, profit = 300, loss = 300)`);
        expect(s.position_size).toBeGreaterThan(0);
    });

    it('strategy.exit for an entry id that is neither open nor pending does not check it', async () => {
        const s = await run(`if bar_index == 2
    strategy.exit("p", "ZZ", qty_percent = 0, profit = 300, loss = 300)`);
        expect(s.closedtrades.length).toBe(0);
    });

    it('strategy.close with qty_percent 150 stops the script (the message names strategy.exit)', async () => {
        const p = run(`pct = bar_index >= 0 ? 150.0 : 50.0
if bar_index == 0
    strategy.entry("L", strategy.long, qty = 2)
if bar_index == 3
    strategy.close("L", qty_percent = pct)`);
        await expect(p).rejects.toThrow(PCT_MSG('150'));
    });

    it('strategy.close with a negative qty_percent stops the script', async () => {
        const p = run(`pct = bar_index >= 0 ? -50.0 : 50.0
if bar_index == 0
    strategy.entry("L", strategy.long, qty = 2)
if bar_index == 3
    strategy.close("L", qty_percent = pct)`);
        await expect(p).rejects.toThrow(PCT_MSG('-50'));
    });

    it('strategy.close with qty_percent 0 closes everything', async () => {
        const s = await run(`if bar_index == 0
    strategy.entry("L", strategy.long, qty = 2)
if bar_index == 3
    strategy.close("L", qty_percent = 0)`);
        expect(s.closedtrades.length).toBe(1);
        expect(s.closedtrades[0].size).toBe(2);
        expect(s.position_size).toBe(0);
    });

    it('strategy.close with nothing to close does not check it', async () => {
        const s = await run(`pct = bar_index >= 0 ? 150.0 : 50.0
if bar_index == 2
    strategy.close("L", qty_percent = pct)
if bar_index == 4
    strategy.entry("L", strategy.long, qty = 2)`);
        expect(s.position_size).toBe(2);
    });
});

describe('direction of a pending order id (RE10028)', () => {
    it('strategy.entry re-placed on a later bar with the other direction', async () => {
        const p = run(`if bar_index == 0
    strategy.entry("R", strategy.long, limit = close * 0.9)
if bar_index == 1
    strategy.entry("R", strategy.short, limit = close * 1.001)`);
        await expect(p).rejects.toThrow(DIR_MSG('strategy.entry', 'R', 'long', 'short'));
    });

    it('a market strategy.entry re-placed on the same bar with the other direction', async () => {
        const p = run(`if bar_index == 2
    strategy.entry("R", strategy.long)
    strategy.entry("R", strategy.short)`);
        await expect(p).rejects.toThrow(DIR_MSG('strategy.entry', 'R', 'long', 'short'));
    });

    it('strategy.order re-placed with the other direction', async () => {
        const p = run(`if bar_index == 0
    strategy.order("R", strategy.long, limit = close * 0.9)
if bar_index == 1
    strategy.order("R", strategy.short, limit = close * 1.001)`);
        await expect(p).rejects.toThrow(DIR_MSG('strategy.order', 'R', 'long', 'short'));
    });

    it('across commands, the message names the command of the pending order', async () => {
        const a = run(`if bar_index == 0
    strategy.entry("R", strategy.long, limit = close * 0.9)
if bar_index == 1
    strategy.order("R", strategy.short, limit = close * 1.001)`);
        await expect(a).rejects.toThrow(DIR_MSG('strategy.entry', 'R', 'long', 'short'));
        const b = run(`if bar_index == 0
    strategy.order("R", strategy.long, limit = close * 0.9)
if bar_index == 1
    strategy.entry("R", strategy.short, limit = close * 1.001)`);
        await expect(b).rejects.toThrow(DIR_MSG('strategy.order', 'R', 'long', 'short'));
    });

    it('the same direction modifies the order, and a filled id can reverse', async () => {
        const s = await run(`if bar_index == 0
    strategy.entry("R", strategy.long, limit = close * 0.9)
if bar_index == 1
    strategy.entry("R", strategy.long, qty = 2)
if bar_index == 4
    strategy.entry("R", strategy.short)`);
        expect(s.closedtrades.map((t) => [t.entry_id, t.size])).toEqual([['R', 2]]);
        expect(s.position_size).toBe(-1);
    });
});

describe('strategy.exit without a price leg (CE10042)', () => {
    const MSG =
        'strategy.exit must have at least one of the following parameters: "profit", "limit", "loss", "stop" or one of the following pairs: "trail_offset" and "trail_price" / "trail_points". To close the position at market price, use "strategy.close"';

    it('qty alone is rejected', async () => {
        const p = run(`if bar_index == 0
    strategy.entry("L", strategy.long, qty = 2)
if bar_index == 1
    strategy.exit("x", "L", qty = 1)`);
        await expect(p).rejects.toThrow(MSG);
    });

    it('trail_offset or trail_points alone is rejected', async () => {
        for (const leg of ['trail_offset = 200', 'trail_points = 100', 'trail_price = close']) {
            const p = run(`if bar_index == 0
    strategy.entry("L", strategy.long, qty = 2)
if bar_index == 1
    strategy.exit("x", "L", ${leg})`);
            await expect(p).rejects.toThrow(MSG);
        }
    });

    it('a leg given as na is a leg: the call places nothing', async () => {
        const s = await run(`if bar_index == 0
    strategy.entry("L", strategy.long, qty = 2)
if bar_index == 1
    strategy.exit("x", "L", profit = na)`);
        expect(s.position_size).toBe(2);
    });

    it('trail_offset with trail_points is a trailing exit', async () => {
        const s = await run(`if bar_index == 0
    strategy.entry("L", strategy.long, qty = 2)
if bar_index == 1
    strategy.exit("x", "L", trail_points = 1, trail_offset = 1)`);
        expect(s.closedtrades.map((t) => t.exit_id)).toEqual(['x']);
    });
});
