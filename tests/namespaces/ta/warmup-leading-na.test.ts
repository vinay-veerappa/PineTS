// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Warmup of the ta window functions on sources with leading or interleaved `na`.
 *
 * Expected values are TradingView's output (Oct 2026) on bar_index 0..29 for the script below; its
 * sources depend on bar_index only. Rules they show:
 *
 *   - ta.highest / ta.lowest / *bars / ta.stoch / ta.wpr and the pivots have a value from bar_index
 *     `length - 1` on (in a local block too: bars, not calls), over the non-na values seen so far when
 *     there are fewer than `length`. So `ta.highest(x[1], 5)` has one on bar 4, a bar before
 *     `ta.highest(x, 5)[1]`. ta.range keeps waiting for `length` non-na values.
 *   - ta.wma (and ta.hma) waits for `length` non-na values, even when the na bars filled forward
 *     already span `length` bars.
 *   - ta.bb / ta.bbw on an na bar give the bands of the unchanged window (as ta.sma / ta.stdev);
 *     ta.kc / ta.kcw are na there (as ta.ema).
 */
import { describe, it, expect } from 'vitest';
import { PineTS } from '../../../src/PineTS.class';

const na = 'na' as const;
type Cell = number | typeof na;

const SCRIPT = `//@version=6
indicator("ta warmup with leading na", overlay=false)
var float[] pat = array.from(5., 3, 8, 6, 2, 9, 4, 7, 1, 6, 3, 10, 5, 2, 8, 4)
float x = array.get(pat, bar_index % 16)
float lead = bar_index < 7 ? na : x
float gap = bar_index % 4 == 1 or bar_index % 4 == 2 ? na : x
float hE = na
float hbE = na
float wE = na
float wprE = na
if bar_index % 2 == 0
    hE := ta.highest(x, 5)
    hbE := ta.highestbars(x, 5)
    wE := ta.wma(x, 5)
    wprE := ta.wpr(5)
[bbMid, bbUp, bbLo] = ta.bb(gap, 5, 2)
[kcMid, kcUp, kcLo] = ta.kc(gap, 5, 1)
plot(ta.highest(x[1], 5), "hs1")
plot(ta.highest(x, 5)[1], "hs1b")
plot(ta.lowest(x[1], 5), "ls1")
plot(ta.lowest(x, 5)[1], "ls1b")
plot(ta.highest(lead, 5), "hLead")
plot(ta.lowest(lead, 5), "lLead")
plot(ta.highestbars(lead, 5), "hbLead")
plot(ta.lowestbars(lead, 5), "lbLead")
plot(ta.highest(gap, 5), "hGap")
plot(ta.lowest(gap, 5), "lGap")
plot(ta.highestbars(gap, 5), "hbGap")
plot(ta.lowestbars(gap, 5), "lbGap")
plot(ta.stoch(lead, lead, lead, 5), "stLead")
plot(ta.stoch(gap, gap, gap, 5), "stGap")
plot(ta.pivothigh(lead, 2, 2), "phLead")
plot(ta.pivotlow(lead, 2, 2), "plLead")
plot(ta.pivothigh(gap, 2, 2), "phGap")
plot(ta.pivotlow(gap, 2, 2), "plGap")
plot(hE, "hE")
plot(hbE, "hbE")
plot(wE, "wE")
plot(wprE, "wprE")
plot(ta.wma(lead, 5), "wLead")
plot(ta.wma(gap, 5), "wGap")
plot(ta.hma(gap, 5), "hmaGap")
plot(bbUp, "bbUp")
plot(ta.bbw(gap, 5, 2), "bbwGap")
plot(kcMid, "kcMid")
plot(ta.kcw(gap, 5, 1), "kcwGap")
plot(ta.range(gap, 5), "rGap")
`;

// TradingView, bar_index 0..29
const TV: Record<string, Cell[]> = {
    hs1: [na, na, na, na, 8, 8, 9, 9, 9, 9, 9, 7, 10, 10, 10, 10, 10, 8, 8, 8, 8, 8, 9, 9, 9, 9, 9, 7, 10, 10],
    hs1b: [na, na, na, na, na, 8, 9, 9, 9, 9, 9, 7, 10, 10, 10, 10, 10, 8, 8, 8, 8, 8, 9, 9, 9, 9, 9, 7, 10, 10],
    ls1: [na, na, na, na, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1],
    ls1b: [na, na, na, na, na, 2, 2, 2, 2, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1],
    hLead: [na, na, na, na, na, na, na, 7, 7, 7, 7, 10, 10, 10, 10, 10, 8, 8, 8, 8, 8, 9, 9, 9, 9, 9, 7, 10, 10, 10],
    lLead: [na, na, na, na, na, na, na, 7, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1, 2],
    hbLead: [na, na, na, na, na, na, na, 0, -1, -2, -3, 0, -1, -2, -3, -4, -2, -3, 0, -1, -2, 0, -1, -2, -3, -4, -3, 0, -1, -2],
    lbLead: [na, na, na, na, na, na, na, 0, 0, -1, -2, -3, -4, 0, -1, -2, -3, -4, -1, -2, 0, -1, -2, -3, 0, -1, -2, -3, -4, 0],
    hGap: [na, na, na, na, 6, 6, 6, 7, 7, 7, 7, 10, 10, 10, 10, 10, 10, 10, 10, 10, 6, 6, 6, 7, 7, 7, 7, 10, 10, 10],
    lGap: [na, na, na, na, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 4, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1],
    hbGap: [na, na, na, na, -1, -2, -3, 0, -1, -2, -3, 0, -1, -2, -3, -4, -5, -6, -7, -8, -1, -2, -3, 0, -1, -2, -3, 0, -1, -2],
    lbGap: [na, na, na, na, 0, -1, -2, -3, 0, -1, -2, -3, -4, -5, -6, -7, -8, -9, -10, -4, 0, -1, -2, -3, 0, -1, -2, -3, -4, -5],
    stLead: [
        na, na, na, na, na, na, na, na, 0, 83.3333333333, 33.3333333333, 100, 44.4444444444, 0, 75, 25, 50, 16.6666666667, 100, 60, 0, 100,
        28.5714285714, 71.4285714286, 0, 62.5, 33.3333333333, 100, 44.4444444444, 0,
    ],
    stGap: [
        na, na, na, na, 0, 0, 0, 100, 0, 0, 0, 100, 44.4444444444, 44.4444444444, 44.4444444444, 33.3333333333, 44.4444444444, 44.4444444444,
        44.4444444444, 33.3333333333, 0, 0, 0, 100, 0, 0, 0, 100, 44.4444444444, 44.4444444444,
    ],
    phLead: [na, na, na, na, na, na, na, na, na, 7, na, na, na, 10, na, na, 8, na, na, na, 8, na, na, 9, na, na, na, na, na, 10],
    plLead: [na, na, na, na, na, na, na, na, na, na, 1, na, na, na, na, 2, na, na, na, 3, na, na, 2, na, na, na, 1, na, na, na],
    phGap: [na, na, na, na, na, 6, na, na, na, 7, na, na, na, 10, na, na, na, na, na, na, na, 6, na, na, na, 7, na, na, na, 10],
    plGap: [na, na, na, na, na, na, 2, na, na, na, 1, na, na, na, na, na, na, na, na, na, na, na, 2, na, na, na, 1, na, na, na],
    hE: [na, na, na, na, 8, na, 8, na, 8, na, 8, na, 5, na, 8, na, 8, na, 8, na, 8, na, 8, na, 8, na, 8, na, 5, na],
    hbE: [na, na, na, na, -2, na, -4, na, -6, na, -8, na, 0, na, 0, na, -2, na, 0, na, -2, na, -4, na, -6, na, -8, na, 0, na],
    wE: [
        na, na, na, na, na, na, na, na, 2.6, na, 2.2666666667, na, 3.2666666667, na, 5.6, na, 6.4, na, 6.6, na, 5.4, na, 3.8666666667, na, 2.6,
        na, 2.2666666667, na, 3.2666666667, na,
    ],
    wLead: [
        na, na, na, na, na, na, na, na, na, na, na, 5.9333333333, 5.8, 4.8, 5.7333333333, 5.2, 4.9333333333, 4.3333333333, 5.5333333333,
        5.6666666667, 4.6, 6, 5.4666666667, 5.8666666667, 4.3333333333, 4.8, 4, 5.9333333333, 5.8, 4.8,
    ],
    wGap: [
        na, na, na, na, na, na, na, na, 3, na, na, 4.4, 4.7333333333, na, na, 5, 4.7333333333, na, na, 5.2666666667, 4.2666666667, na, na,
        3.9333333333, 3, na, na, 4.4, 4.7333333333, na,
    ],
    hmaGap: [
        na, na, na, na, na, na, na, na, na, na, na, 7.4, 8.9333333333, na, na, 5.3111111111, 4.2888888889, na, na, 5.5777777778, 3.6222222222,
        na, na, 5.2888888889, 4.2444444444, na, na, 7.4, 8.9333333333, na,
    ],
    bbUp: [
        na, na, na, na, na, na, na, na, 8.8303347611, 8.8303347611, 8.8303347611, 11.8211781429, 11.5726706901, 11.5726706901, 11.5726706901,
        11.4133185513, 10.7965506985, 10.7965506985, 10.7965506985, 10.1952353927, 7.1129319933, 7.1129319933, 7.1129319933, 8.2409301068,
        8.8303347611, 8.8303347611, 8.8303347611, 11.8211781429, 11.5726706901, 11.5726706901,
    ],
    bbwGap: [
        na, na, na, na, na, na, na, na, 220.4921314817, 220.4921314817, 220.4921314817, 254.6606978038, 262.9068276025, 262.9068276025,
        262.9068276025, 222.7155019018, 231.862027939, 231.862027939, 231.862027939, 139.841179756, 123.3150906023, 123.3150906023,
        123.3150906023, 143.372087784, 220.4921314817, 220.4921314817, 220.4921314817, 254.6606978038, 262.9068276025, 262.9068276025,
    ],
    kcMid: [
        na, na, na, na, na, na, na, na, 4.2, na, na, 6.1333333333, 5.7555555556, na, na, 5.1703703704, 5.1135802469, na, na, 5.4090534979,
        4.272702332, na, na, 5.1818015546, 3.7878677031, na, na, 5.8585784687, 5.5723856458, na,
    ],
    rGap: [na, na, na, na, na, na, na, na, 6, 6, 6, 9, 9, 9, 9, 9, 9, 9, 9, 6, 4, 4, 4, 5, 6, 6, 6, 9, 9, 9],
};

// TradingView, bar_index 0..29: whether the value is na (the values depend on the chart's prices)
const TV_NA: Record<string, string> = {
    wprE: 'nananana1na1na1na1na1na1na1na1na1na1na1na1na1na',
    kcwGap: 'nananananananana1nana11nana11nana11nana11nana11na',
};

function syntheticBars(n: number) {
    const H = 3_600_000;
    const t0 = Date.UTC(2024, 0, 1);
    return Array.from({ length: n }, (_, i) => ({
        openTime: t0 + i * H,
        closeTime: t0 + (i + 1) * H,
        open: 100,
        high: 101 + (i % 3),
        low: 99 - (i % 2),
        close: 100 + (i % 5) / 4,
        volume: 1,
    }));
}

const BARS = 30;

async function run() {
    const { plots } = await new PineTS(syntheticBars(BARS), 'SYN', '60').run(SCRIPT);
    return (name: string): Cell[] => plots[name].data.slice(0, BARS).map((p: any) => (Number.isNaN(p.value) || p.value == null ? na : (p.value as number)));
}

function expectCells(actual: Cell[], expected: Cell[], label: string) {
    expect(actual.length, label).toBe(expected.length);
    expected.forEach((e, i) => {
        if (e === na) expect(actual[i], `${label}[${i}]`).toBe(na);
        else expect(actual[i], `${label}[${i}]`).toBeCloseTo(e, 8);
    });
}

const naPattern = (cells: Cell[]) => cells.map((c) => (c === na ? 'na' : '1')).join('');

describe('ta warmup on sources with leading / interleaved na (TradingView parity)', () => {
    it('ta.highest(x[1], n) has a value one bar before ta.highest(x, n)[1]', async () => {
        const values = await run();
        expect(values('hs1')[4]).toBe(8);
        expect(values('hs1b')[4]).toBe(na);
        for (const name of ['hs1', 'hs1b', 'ls1', 'ls1b']) expectCells(values(name), TV[name], name);
    });

    it('highest / lowest / *bars start at bar_index length - 1 over the non-na values seen', async () => {
        const values = await run();
        for (const name of ['hLead', 'lLead', 'hbLead', 'lbLead', 'hGap', 'lGap', 'hbGap', 'lbGap']) expectCells(values(name), TV[name], name);
    });

    it('stoch and the pivots follow the same warmup', async () => {
        const values = await run();
        for (const name of ['stLead', 'stGap', 'phLead', 'plLead', 'phGap', 'plGap']) expectCells(values(name), TV[name], name);
    });

    it('counts bars, not calls, in a local block', async () => {
        const values = await run();
        for (const name of ['hE', 'hbE', 'wE']) expectCells(values(name), TV[name], name);
        expect(naPattern(values('wprE'))).toBe(TV_NA.wprE);
    });

    it('ta.wma / ta.hma wait for `length` non-na values', async () => {
        const values = await run();
        for (const name of ['wLead', 'wGap', 'hmaGap']) expectCells(values(name), TV[name], name);
    });

    it('ta.bb / ta.bbw hold their window on na bars; ta.kc / ta.kcw are na there', async () => {
        const values = await run();
        for (const name of ['bbUp', 'bbwGap', 'kcMid']) expectCells(values(name), TV[name], name);
        expect(naPattern(values('kcwGap'))).toBe(TV_NA.kcwGap);
    });

    it('ta.range still waits for `length` non-na values', async () => {
        const values = await run();
        expectCells(values('rGap'), TV.rGap, 'rGap');
    });
});
