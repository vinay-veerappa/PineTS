// SPDX-License-Identifier: AGPL-3.0-only
// request.security on a LOWER timeframe returns one intrabar per chart bar: the first with
// lookahead_on, the last with lookahead_off (historical bars).
//
// Measured on TradingView (BINANCE:BTCUSDT 1h, Pine v6, 2 999 historical bars from 2026-06-13 to
// 2026-10-18): `request.security(syminfo.tickerid, "5", close, lookahead = barmerge.lookahead_on)`
// equals the close of the chart bar's FIRST 5-minute bar on 2 999 / 2 999 bars, and the same call with
// lookahead_off the close of its LAST 5-minute bar on 2 999 / 2 999 bars. The values asserted below are
// TradingView's for the 2026-06-17 20:00-23:00 UTC bars; the 5-minute closes are Binance's.

import { describe, it, expect, vi } from 'vitest';
import { PineTS, Indicator } from '../../src';

const START_5M = Date.UTC(2026, 5, 16, 22); // 26 hours of 5m history: warms up ta.ema(close, 20)
// prettier-ignore
const CLOSES_5M = [65754.09,65765.67,65842,65881.99,65722.05,65776.92,65726,65740,65720.64,65689.18,65732.4,65780,65814,65774.66,65762.92,65685.99,65671.98,65732,65762,65753.57,65722.68,65650.29,65675.03,65675.01,65694.77,65736,65751.09,65792.56,65718,65725.95,65808.01,65805.72,65832.01,65840.29,65710.02,65700,65798,65790,65805.29,65595,65568.01,65585.74,65602.01,65678.01,65759.76,65892.94,65876,65940,65905.15,65853.3,65905.21,65897.99,66086.28,66106,65920,65788.01,65858.05,65881.94,65866.32,65904,65861.65,65840.57,65820.01,65755.64,65730.02,65780,65843.99,65814,65797.98,65791.8,65842.36,65851.99,65852,65855.46,65839.34,65791.99,65892,65906.95,65890,65923.99,65927.99,66036.11,65950,65892,65963.15,65808.01,65818,65774.06,65800,65856,65867.99,65872.04,65919.03,65862.01,65780.01,65836.3,65845,65852.01,65862,65884.03,65844.02,65650.01,65718,65670,65639.25,65669.99,65639.26,65624,65583.99,65656.01,65688,65620.7,65510.01,65555.79,65550,65506,65540.1,65469.35,65315.81,65539.5,65473.25,65435.99,65340.5,65293.03,65341.14,65330.01,65195.99,64990.77,64920.01,64903.99,64922.01,64926.02,64995.76,64962.95,64975.99,65024,64994,65045.99,64984.01,64970,64947.74,64992,64873.53,64909.44,64847.62,64848.07,64879.98,64880.66,64932.59,64936,64948.43,64912,64924,64879.77,64817.99,64798,64712.25,64672.01,64605.59,64625.99,64641.9,64704.91,64733.99,64756.47,64790.71,64836.62,64844.85,64810.01,64827.85,64855.66,64850.18,64826.69,64686.25,64687.99,64779.99,64812.78,64914.6,65020.01,64952.23,65040.88,65018.62,64997.99,65083.99,65049.99,64901.26,64927.99,65028.98,65221.79,65280,65292,65327.99,65278,65196,65212,65345.99,65265.44,65253.99,65252,65204.76,65104,65111.42,65087.99,65266.18,65101.45,65191.99,64992,65234.27,65216,65366,65327.76,65386.96,65476.01,65493.99,65700,65692,65752,65842.72,65806.44,65847.99,65935.99,65949.99,66258,66006.21,66018.87,65970.1,65943.99,65929.29,65864.12,65892,65916.41,65864.01,65944,65972,65973.99,65956.01,65940.03,65858.66,65855.99,66104.65,66104.08,65248.3,65478.02,65301.52,65458,65378.93,65404.14,65288.82,65584.94,66036.87,65924.01,65880.01,65516,65453.99,65213.59,65366.01,64772.69,64625.08,64470,64432.93,64290.08,64178.25,64166.42,64167.98,64301.85,64416,64365.29,64214.69,64325.9,64360,64361.11,64417.07,64366.1,64232.17,64320.03,64278.68,64434.36,64350.01,64360.01,64328.92,64325.15,64363.99,64266,64344.05,64375.99,64190,64213.98,64269.99,64257.77,63993.99,64196.36,64103.99,64152,64287.91,64364.42,64400.46,64342.01,64266.01,64396,64394,64300.01,64404,64318,64317.99,64460.87,64477.99,64496,64457.84,64467.06,64443.69,64476.01,64511.99,64509.4];

// TradingView, per 60m chart bar: [time, e5on = ema(close, 20)[1] lookahead_on, c5off, c5on]
const TV = [
    [Date.UTC(2026, 5, 17, 20), 64850.0189980691, 64434.36, 64416],
    [Date.UTC(2026, 5, 17, 21), 64494.0059245369, 64257.77, 64350.01],
    [Date.UTC(2026, 5, 17, 22), 64351.8225635951, 64300.01, 63993.99],
    [Date.UTC(2026, 5, 17, 23), 64312.822619038, 64509.4, 64404],
];

const M5 = 5 * 60000;
const H1 = 60 * 60000;
const bars5 = CLOSES_5M.map((c, i) => ({ openTime: START_5M + i * M5, closeTime: START_5M + (i + 1) * M5 - 1, open: c, high: c, low: c, close: c, volume: 1 }));
const bars60 = TV.map(([t]) => {
    const sub = bars5.filter((b) => b.openTime >= t && b.openTime < t + H1);
    return { openTime: t, closeTime: t + H1 - 1, open: sub[0].open, high: Math.max(...sub.map((b) => b.high)), low: Math.min(...sub.map((b) => b.low)), close: sub[sub.length - 1].close, volume: 12 };
});

describe('request.security lower timeframe lookahead', () => {
    it('lookahead_on returns the first intrabar, lookahead_off the last (historical bars)', async () => {
        const sym = { tickerid: 'BINANCE:BTCUSDT', ticker: 'BTCUSDT', type: 'crypto', currency: 'USDT', timezone: 'Etc/UTC', mintick: 0.01, pointvalue: 1, minmove: 1, pricescale: 100, session: '24x7' };
        const provider = {
            configure() {},
            getSymbolInfo: async () => sym,
            getMarketData: async (_t: string, tf: string) => (tf === '5' ? bars5 : bars60).map((b) => ({ ...b })),
        };
        const lines: string[] = [];
        const spy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => {
            lines.push(a.join(' '));
        });
        try {
            await new PineTS(provider as any, 'BINANCE:BTCUSDT', '60', null, bars60[0].openTime, bars60[bars60.length - 1].closeTime).run(
                new Indicator(`//@version=6
indicator("ltf lookahead")
e5on = request.security(syminfo.tickerid, "5", ta.ema(close, 20)[1], lookahead = barmerge.lookahead_on)
c5off = request.security(syminfo.tickerid, "5", close, lookahead = barmerge.lookahead_off)
c5on = request.security(syminfo.tickerid, "5", close, lookahead = barmerge.lookahead_on)
f(float v) => str.tostring(v, "#.##########")
log.info("R|" + str.tostring(time) + "|" + f(e5on) + "|" + f(c5off) + "|" + f(c5on))
`),
            );
        } finally {
            spy.mockRestore();
        }
        const rows = lines
            .map((l) => l.match(/R\|(.*)/)?.[1])
            .filter(Boolean)
            .map((s) => s!.split('|').map((v) => Number(v.replace(/,/g, ''))));
        expect(rows.length).toBe(TV.length);
        rows.forEach(([time, e5on, c5off, c5on], i) => {
            expect(time).toBe(TV[i][0]);
            expect(c5on).toBe(TV[i][3]);
            expect(c5off).toBe(TV[i][2]);
            expect(e5on).toBeCloseTo(TV[i][1], 6);
        });
    });
});
