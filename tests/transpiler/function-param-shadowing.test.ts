// SPDX-License-Identifier: AGPL-3.0-only
// A function parameter shadows a global variable of the same name, also when the parameter is passed
// to a built-in (`na(x)`, `str.tostring(x)`) inside the function body.
//
// Measured on TradingView (BINANCE:BTCUSDT 1h, Pine v6, 2026-09-17 22:00 UTC bar): a script with a
// global `var float x` reassigned every bar and `__f(float x) => na(x) ? "na" : str.tostring(x, "#.##########")`
// logs `__f(open)` = "76415.85" (the bar's open) and `__f(syminfo.mintick)` = "0.01".

import { describe, it, expect, vi } from 'vitest';
import { PineTS, Indicator } from '../../src';

const BARS = [
    { openTime: 1789682400000, closeTime: 1789685999999, open: 76415.85, high: 76458.55, low: 76259.98, close: 76420, volume: 270.75161 },
    { openTime: 1789686000000, closeTime: 1789689599999, open: 76419.99, high: 76510.01, low: 76384.04, close: 76417.01, volume: 255.57512 },
];

async function logs(src: string): Promise<string[]> {
    const sym = { tickerid: 'BINANCE:BTCUSDT', ticker: 'BTCUSDT', type: 'crypto', currency: 'USDT', timezone: 'Etc/UTC', mintick: 0.01, pointvalue: 1, minmove: 1, pricescale: 100, session: '24x7' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => BARS.map((b) => ({ ...b })) };
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => {
        lines.push(a.join(' '));
    });
    try {
        await new PineTS(provider as any, 'BINANCE:BTCUSDT', '60', null, BARS[0].openTime, BARS[1].closeTime).run(new Indicator(src));
    } finally {
        spy.mockRestore();
    }
    return lines.map((l) => l.match(/R\|.*/)?.[0]).filter(Boolean) as string[];
}

describe('function parameter shadowing a global', () => {
    it('a parameter passed to na() / str.tostring() reads the argument, not the global var', async () => {
        const out = await logs(`//@version=6
indicator("shadow")
var float x = na
x := 7 - (close - 99)
__f(float x) => na(x) ? "na" : str.tostring(x, "#.##########")
log.info("R|" + __f(open) + "|" + __f(syminfo.mintick))
`);
        expect(out[0]).toBe('R|76415.85|0.01');
        expect(out[1]).toBe('R|76419.99|0.01');
    });

    it('same with a plain global, a multi-line body and an untyped parameter', async () => {
        const out = await logs(`//@version=6
indicator("shadow")
x = 7.0
g(float x) => na(x) ? "na" : str.tostring(x * 2)
h(x) =>
    y = str.tostring(x * 2)
    na(x) ? "na" : y
k(float x) => x * 2
log.info("R|" + g(1.0) + "|" + h(1.0) + "|" + str.tostring(k(1.0)) + "|" + str.tostring(x))
`);
        expect(out[0]).toBe('R|2|2|2|7');
    });
});
