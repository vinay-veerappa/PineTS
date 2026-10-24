// SPDX-License-Identifier: AGPL-3.0-only
// math.round_to_mintick on values that fall on (or within float noise of) a half tick.
//
// Measured on TradingView (Pine v6, `math.round_to_mintick(<expr> * o)` with `o` a series 1.0):
// 594 half-tick values on BINANCE:BTCUSDT (mintick 0.01) and 304 on FX:EURUSD (mintick 0.00001).
// TradingView rounds the exact binary value half up in tick units, magnitude first (negatives are
// symmetric), and treats a value up to 1e-10 tick below the half tick as the half tick: on both
// symbols every value at most 0.87e-10 tick below rounded up, every value at least 1.16e-10 tick
// below rounded down. Rounding `v / mintick` in double precision disagreed with TradingView on 23 %
// of these values, in both directions.

import { describe, it, expect, vi } from 'vitest';
import { PineTS, Indicator } from '../../../src';

async function roundAll(mintick: number, exprs: string[]): Promise<string[]> {
    const decimals = Math.round(-Math.log10(mintick));
    const sym = { tickerid: 'X:T', ticker: 'T', type: 'crypto', currency: 'USD', timezone: 'Etc/UTC', mintick, pointvalue: 1, minmove: 1, pricescale: 10 ** decimals, session: '24x7' };
    const bars = [0, 1].map((i) => ({ openTime: 1e12 + i * 36e5, closeTime: 1e12 + (i + 1) * 36e5 - 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars.map((b) => ({ ...b })) };
    const src = `//@version=6
indicator("rtm")
f(float v) => str.tostring(v, "#.##########")
float o = bar_index * 0 + 1.0
if bar_index == 0
${exprs.map((e, i) => `    log.info("R|${i}|" + f(math.round_to_mintick(${e.replace(/(-?\d+(\.\d+)?)/g, '$1 * o')})))`).join('\n')}
`;
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => {
        lines.push(a.join(' '));
    });
    try {
        await new PineTS(provider as any, 'X:T', '60', null, bars[0].openTime, bars[1].closeTime).run(new Indicator(src));
    } finally {
        spy.mockRestore();
    }
    const out: string[] = [];
    for (const l of lines) {
        const m = l.match(/R\|(\d+)\|(.*)$/);
        if (m) out[+m[1]] = m[2];
    }
    return out;
}

describe('math.round_to_mintick half-tick ties', () => {
    it('mintick 0.01 (TradingView, BINANCE:BTCUSDT)', async () => {
        // [expression, TradingView result]
        const cases: [string, string][] = [
            // the double is just below the half tick: up within 1e-10 tick, down beyond it
            ['0.575', '0.58'],
            ['1.015', '1.02'],
            ['18.455', '18.46'],
            ['1032.975', '1032.98'],
            ['10419.185', '10419.19'],
            ['66567.38 - (66567.38 - 66368.15) * 0.5', '66467.77'],
            ['78720 - (78720 - 78338.03) * 0.5', '78529.02'],
            ['63649.99 - (63649.99 - 63524.82) * 0.5', '63587.4'],
            ['62441.29 + (62471.52 - 62441.29) * 0.5', '62456.4'],
            ['43927.905', '43927.9'],
            ['1132960.785', '1132960.78'],
            ['137863.955', '137863.95'],
            // p01 strategy (trade 7's stop: exit 62901.59 = 62901.57 + 2 ticks of slippage)
            ['63029.64 - (63029.64 - 62773.51) * 0.5', '62901.57'],
            // exact binary half ticks round up
            ['0.125', '0.13'],
            ['100.125', '100.13'],
            ['65536.875', '65536.88'],
            // negatives mirror the positives
            ['-62901.575', '-62901.57'],
            ['-66467.765', '-66467.77'],
            ['-1.005', '-1.01'],
            ['-100.125', '-100.13'],
        ];
        expect(await roundAll(0.01, cases.map((c) => c[0]))).toEqual(cases.map((c) => c[1]));
    });

    it('mintick 0.00001 (TradingView, FX:EURUSD)', async () => {
        const cases: [string, string][] = [
            ['0.134685', '0.13469'],
            ['0.577105', '0.57711'],
            ['15.025965', '15.02597'],
            ['17.036575', '17.03658'],
            ['18.480095', '18.48009'],
            ['17.711045', '17.71104'],
            ['110.086895', '110.08689'],
            ['114.410945', '114.41094'],
            // large quotients (~1e10 ticks): the double v / mintick is off by more than 1e-6 tick
            ['124397.541975', '124397.54198'],
            ['591697.841595', '591697.8416'],
            ['556995.712665', '556995.71266'],
        ];
        expect(await roundAll(0.00001, cases.map((c) => c[0]))).toEqual(cases.map((c) => c[1]));
    });

    it('values away from a half tick round to the nearest tick', async () => {
        expect(await roundAll(0.01, ['62901.5749', '62901.5751', '0', '1.2345678', '-3.456'])).toEqual(['62901.57', '62901.58', '0', '1.23', '-3.46']);
    });
});
