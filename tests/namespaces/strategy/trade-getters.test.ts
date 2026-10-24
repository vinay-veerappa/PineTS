// SPDX-License-Identifier: AGPL-3.0-only
// strategy.closedtrades.* / strategy.opentrades.* and related getters as measured on TradingView
// (Pine v6). The bars below replay the trades of the TradingView runs; every expected number is the
// value TradingView logged for that trade or bar:
//   - out-of-range trade_num (−1, count): size / profit / profit_percent / commission are 0, prices,
//     bar indexes and times na, ids "" (every bar of 26 runs on BTCUSDT 1h, ES1! 1D, EURUSD 1h, AAPL 1D);
//   - trade_num = na reads trade 0 (31,319 closed-trade and 21,013 open-trade bar checks);
//   - opentrades.profit / profit_percent mark to the close on the tick grid, as strategy.openprofit
//     (BATS:AAPL 1D, close 126.655 traded as 126.66);
//   - the *_percent getters divide by the signed entry notional plus the entry commission, also when
//     prices are negative (NYMEX:CL1! back-adjusted 1D, April–May 2020);
//   - only the last 9,000 closed trades stay listed: closedtrades.first_index = closedtrades − 9,000,
//     a trade below it reads as out of range, the counts are not truncated (BINANCE:BTCUSDT 1h, 19,990
//     closed trades);
//   - margin_liquidation_price for a long with margin_long above 100;
//   - default_entry_qty keeps the sign of a negative fill price, truncated toward zero.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close
type Sym = { type: string; mintick: number; pointvalue: number; mincontract: number };

const AAPL: Sym = { type: 'stock', mintick: 0.01, pointvalue: 1, mincontract: 1 };
const CL: Sym = { type: 'futures', mintick: 0.01, pointvalue: 1000, mincontract: 1 };
const BTC: Sym = { type: 'crypto', mintick: 0.01, pointvalue: 1, mincontract: 0.00001 };

async function run(decl: string, body: string, ohlc: Bar[], sym: Sym) {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 3_600_000, closeTime: (i + 2) * 3_600_000 - 1, open, high, low, close, volume: 1 }));
    const info = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', currency: 'USD', timezone: 'UTC', minmove: 1, pricescale: 100, session: '24x7', description: 'X', ...sym };
    const provider = { configure() {}, getSymbolInfo: async () => info, getMarketData: async () => bars };
    const src = `//@version=6\nstrategy("t", ${decl})\n${body}`;
    const ctx: any = await new PineTS(provider, 'TEST:X', '60', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src));
    return (title: string): any[] => ctx.plots[title].data.map((d: any) => d.value);
}

const isNa = (x: any) => x === null || x === undefined || Number.isNaN(x);

// ga-long@AAPL-1D: trade 0 long 100 @ 122.02 → 124.53, then long 100 @ 128.96 open on the bar that
// closes at 126.655; commission 0.1 %.
const AAPL_LONG: Bar[] = [
    [121.5, 122.3, 121.2, 122.0],
    [122.02, 123, 121.9, 122.5],
    [124.53, 125, 124, 124.8],
    [128.96, 129.1, 126.12, 126.655],
    [126.7, 127, 126, 126.5],
];
const AAPL_LONG_DECL = 'initial_capital = 1000000, default_qty_type = strategy.fixed, default_qty_value = 100, commission_type = strategy.commission.percent, commission_value = 0.1';
const AAPL_LONG_BODY = `
if bar_index == 0 or bar_index == 2
    strategy.entry("L", strategy.long)
if bar_index == 1
    strategy.close("L")
int k = na
n = strategy.closedtrades
m = strategy.opentrades
plot(strategy.closedtrades.size(-1), "c-1 size")
plot(strategy.closedtrades.profit(-1), "c-1 profit")
plot(strategy.closedtrades.profit_percent(-1), "c-1 pct")
plot(strategy.closedtrades.commission(-1), "c-1 comm")
plot(strategy.closedtrades.entry_price(-1), "c-1 entry")
plot(strategy.closedtrades.exit_bar_index(-1), "c-1 exitbar")
plot(strategy.closedtrades.size(n), "cN size")
plot(strategy.closedtrades.profit_percent(n), "cN pct")
plot(strategy.closedtrades.commission(n), "cN comm")
plot(strategy.closedtrades.entry_time(n), "cN time")
plot(strategy.opentrades.size(-1), "o-1 size")
plot(strategy.opentrades.profit(-1), "o-1 profit")
plot(strategy.opentrades.profit_percent(-1), "o-1 pct")
plot(strategy.opentrades.commission(-1), "o-1 comm")
plot(strategy.opentrades.entry_price(-1), "o-1 entry")
plot(strategy.opentrades.size(m), "oM size")
plot(strategy.opentrades.profit(m), "oM profit")
plot(strategy.opentrades.profit_percent(m), "oM pct")
plot(strategy.opentrades.commission(m), "oM comm")
plot(strategy.closedtrades.entry_id(k) == "L" ? 1 : 0, "cNA id")
plot(strategy.closedtrades.entry_price(k), "cNA entry")
plot(strategy.closedtrades.exit_price(k), "cNA exit")
plot(strategy.closedtrades.size(k), "cNA size")
plot(strategy.closedtrades.profit(k), "cNA profit")
plot(strategy.closedtrades.profit_percent(k), "cNA pct")
plot(strategy.closedtrades.commission(k), "cNA comm")
plot(strategy.opentrades.entry_id(k) == "L" ? 1 : 0, "oNA id")
plot(strategy.opentrades.entry_price(k), "oNA entry")
plot(strategy.opentrades.size(k), "oNA size")
plot(strategy.opentrades.profit(k), "oNA profit")
plot(strategy.opentrades.profit_percent(k), "oNA pct")
plot(strategy.opentrades.commission(k), "oNA comm")
plot(strategy.opentrades.profit(0), "o0 profit")
plot(strategy.opentrades.profit_percent(0), "o0 pct")
plot(strategy.openprofit, "openprofit")
`;

describe('trade getters: out-of-range trade_num', () => {
    it('numeric getters are 0, prices / bar indexes / times na', async () => {
        const v = await run(AAPL_LONG_DECL, AAPL_LONG_BODY, AAPL_LONG, AAPL);
        for (let bar = 0; bar < AAPL_LONG.length; bar++) {
            for (const t of ['c-1 size', 'c-1 profit', 'c-1 pct', 'c-1 comm', 'cN size', 'cN pct', 'cN comm', 'o-1 size', 'o-1 profit', 'o-1 pct', 'o-1 comm', 'oM size', 'oM profit', 'oM pct', 'oM comm']) {
                expect(v(t)[bar], `${t} @ bar ${bar}`).toBe(0);
            }
            for (const t of ['c-1 entry', 'c-1 exitbar', 'cN time', 'o-1 entry']) expect(isNa(v(t)[bar]), `${t} @ bar ${bar}`).toBe(true);
        }
    });
});

describe('trade getters: trade_num = na reads trade 0', () => {
    it('closed trades', async () => {
        const v = await run(AAPL_LONG_DECL, AAPL_LONG_BODY, AAPL_LONG, AAPL);
        // Before the first close: out of range.
        expect(isNa(v('cNA entry')[1])).toBe(true);
        expect(v('cNA size')[1]).toBe(0);
        // TradingView (ga-long@AAPL-1D bar 37): closed(na) = L, 122.02 → 124.53, size 100,
        // profit 226.345, 1.85312966 %, commission 24.655.
        expect(v('cNA id')[3]).toBe(1);
        expect(v('cNA entry')[3]).toBeCloseTo(122.02, 10);
        expect(v('cNA exit')[3]).toBeCloseTo(124.53, 10);
        expect(v('cNA size')[3]).toBe(100);
        expect(v('cNA profit')[3]).toBeCloseTo(226.345, 8);
        expect(v('cNA pct')[3]).toBeCloseTo(1.85312966, 8);
        expect(v('cNA comm')[3]).toBeCloseTo(24.655, 8);
    });

    it('open trades', async () => {
        const v = await run(AAPL_LONG_DECL, AAPL_LONG_BODY, AAPL_LONG, AAPL);
        // TradingView (same bar): open(na) = L, 128.96, size 100, profit −255.562, −1.979735525 %, commission 12.896.
        expect(v('oNA id')[3]).toBe(1);
        expect(v('oNA entry')[3]).toBeCloseTo(128.96, 10);
        expect(v('oNA size')[3]).toBe(100);
        expect(v('oNA profit')[3]).toBeCloseTo(-255.562, 8);
        expect(v('oNA pct')[3]).toBeCloseTo(-1.979735525, 8);
        expect(v('oNA comm')[3]).toBeCloseTo(12.896, 8);
    });
});

describe('opentrades.profit marks to the close on the tick grid', () => {
    it('long with a percent commission (close 126.655 → 126.66)', async () => {
        const v = await run(AAPL_LONG_DECL, AAPL_LONG_BODY, AAPL_LONG, AAPL);
        // TradingView: (126.66 − 128.96) × 100 − 12.896 − 12.666 = −255.562; openprofit −230.
        expect(v('o0 profit')[3]).toBeCloseTo(-255.562, 8);
        expect(v('o0 pct')[3]).toBeCloseTo(-1.979735525, 8);
        expect(v('openprofit')[3]).toBeCloseTo(-230, 8);
    });

    it('short 2,200 @ 120.5 (ga-margin@AAPL-1D bar 37)', async () => {
        const v = await run(
            'initial_capital = 1000000, default_qty_type = strategy.fixed, default_qty_value = 2200, margin_long = 0, margin_short = 0',
            `if bar_index == 0
    strategy.entry("MS", strategy.short)
plot(strategy.opentrades.profit(0), "p")
plot(strategy.opentrades.profit_percent(0), "pp")
plot(strategy.openprofit, "op")`,
            [
                [121, 121.5, 120.4, 121],
                [120.5, 129.1, 120.3, 126.655],
                [126.7, 127, 126, 126.5],
            ],
            AAPL,
        );
        // TradingView: −13,552 = (120.5 − 126.66) × 2,200; −5.112033195 %; openprofit −13,552.
        expect(v('p')[1]).toBeCloseTo(-13552, 8);
        expect(v('pp')[1]).toBeCloseTo(-5.112033195, 8);
        expect(v('op')[1]).toBeCloseTo(-13552, 8);
    });
});

describe('*_percent getters with a negative cost basis', () => {
    // NYMEX:CL1! back-adjusted 1D, point value 1000, 2 contracts, 3 per contract:
    // short @ −34.99 (closes −35.61, −32.89), exit −23.86; long @ −23.46, exit −14.74.
    const bars: Bar[] = [
        [-34, -33.5, -35, -34.5],
        [-34.99, -34.5, -36, -35.61],
        [-35.5, -32, -35.8, -32.89],
        [-23.86, -23, -25, -24],
        [-23.46, -20, -24, -21],
        [-14.74, -14, -16, -15],
        [-15, -14.5, -15.5, -15],
    ];
    const decl = 'initial_capital = 1000000000, default_qty_type = strategy.fixed, default_qty_value = 2, margin_long = 0, margin_short = 0, commission_type = strategy.commission.cash_per_contract, commission_value = 3';
    const body = `
if bar_index == 0
    strategy.entry("S", strategy.short)
if bar_index == 3
    strategy.entry("L", strategy.long)
if bar_index == 2 or bar_index == 4
    strategy.close_all()
plot(strategy.opentrades.profit(0), "op")
plot(strategy.opentrades.profit_percent(0), "opp")
plot(strategy.closedtrades.profit(0), "c0")
plot(strategy.closedtrades.profit_percent(0), "c0p")
plot(strategy.closedtrades.profit(1), "c1")
plot(strategy.closedtrades.profit_percent(1), "c1p")
plot(strategy.avg_trade_percent, "atp")
plot(strategy.avg_winning_trade_percent, "awp")
plot(strategy.avg_losing_trade_percent, "alp")`;

    it('open trade', async () => {
        const v = await run(decl, body, bars, CL);
        // TradingView: 1,228 / −1.7549375482 %, then −4,212 / 6.0193786263 %.
        expect(v('op')[1]).toBeCloseTo(1228, 8);
        expect(v('opp')[1]).toBeCloseTo(-1.7549375482, 8);
        expect(v('op')[2]).toBeCloseTo(-4212, 8);
        expect(v('opp')[2]).toBeCloseTo(6.0193786263, 8);
    });

    it('closed trades and the averages', async () => {
        const v = await run(decl, body, bars, CL);
        // TradingView: −22,272 / 31.8289650442 % and 17,428 / −37.1488255105 %.
        expect(v('c0').at(-1)).toBeCloseTo(-22272, 8);
        expect(v('c0p').at(-1)).toBeCloseTo(31.8289650442, 8);
        expect(v('c1').at(-1)).toBeCloseTo(17428, 8);
        expect(v('c1p').at(-1)).toBeCloseTo(-37.1488255105, 8);
        // The averages take every trade's percent, winners / losers by the sign of the profit.
        expect(v('atp').at(-1)).toBeCloseTo((31.8289650442 - 37.1488255105) / 2, 8);
        expect(v('awp').at(-1)).toBeCloseTo(-37.1488255105, 8);
        expect(v('alp').at(-1)).toBeCloseTo(31.8289650442, 8);
    });
});

describe('closedtrades.first_index: the last 9,000 closed trades stay listed', () => {
    it('older trades read as out of range, the counts are not truncated', async () => {
        // ga-fi: 10 entries on every even bar, close_all on every odd bar → 10 trades closed per 2 bars;
        // trade k enters on bar 2 × floor(k / 10) + 1.
        const N = 1852;
        const ohlc: Bar[] = Array.from({ length: N }, (_, i) => {
            const c = 100 + (i % 7) * 0.1;
            return [c, c + 0.5, c - 0.5, c];
        });
        const v = await run(
            'initial_capital = 10000000, pyramiding = 10, default_qty_type = strategy.fixed, default_qty_value = 0.001, margin_long = 0, margin_short = 0',
            `if bar_index % 2 == 0
    for i = 0 to 9
        strategy.entry("E" + str.tostring(i), strategy.long)
else
    strategy.close_all()
fi = strategy.closedtrades.first_index
plot(strategy.closedtrades, "n")
plot(fi, "fi")
plot(strategy.closedtrades.entry_bar_index(fi), "ebi fi")
plot(strategy.closedtrades.entry_bar_index(fi - 1), "ebi fi-1")
plot(strategy.closedtrades.entry_bar_index(0), "ebi 0")
plot(strategy.closedtrades.profit(0), "profit 0")
plot(strategy.closedtrades.size(0), "size 0")
plot(strategy.closedtrades.entry_bar_index(strategy.closedtrades - 1), "ebi last")
plot(strategy.wintrades + strategy.losstrades + strategy.eventrades, "counted")`,
            ohlc,
            BTC,
        );
        // 9,000 closed trades: nothing dropped yet.
        expect(v('n')[1800]).toBe(9000);
        expect(v('fi')[1800]).toBe(0);
        expect(v('ebi 0')[1800]).toBe(1);
        // 9,010 / 9,250 closed trades: first_index = closedtrades − 9,000.
        expect(v('n')[1802]).toBe(9010);
        expect(v('fi')[1802]).toBe(10);
        expect(v('ebi fi')[1802]).toBe(3);
        expect(v('n')[1850]).toBe(9250);
        expect(v('fi')[1850]).toBe(250);
        expect(v('ebi fi')[1850]).toBe(51);
        expect(isNa(v('ebi fi-1')[1850])).toBe(true);
        expect(isNa(v('ebi 0')[1850])).toBe(true);
        expect(v('profit 0')[1850]).toBe(0);
        expect(v('size 0')[1850]).toBe(0);
        expect(v('ebi last')[1850]).toBe(1849);
        expect(v('counted')[1850]).toBe(9250);
    }, 120_000);
});

describe('margin_liquidation_price for a long with margin_long above 100', () => {
    it('margin_long = 150 (BINANCE:BTCUSDT 1h)', async () => {
        const v = await run(
            'initial_capital = 10000, default_qty_type = strategy.fixed, default_qty_value = 0.07604, margin_long = 150, margin_short = 150',
            `if bar_index == 0
    strategy.entry("L", strategy.long)
plot(strategy.margin_liquidation_price, "liq")`,
            [
                [65700, 65800, 65600, 65750],
                [65746.45, 65900, 65700, 65800],
                [65800, 65900, 65700, 65850],
            ],
            BTC,
        );
        // TradingView: 131,526.56 = (10,000 / 0.07604 − 65,746.45) / 0.5, rounded down to the tick.
        expect(v('liq')[1]).toBeCloseTo(131526.56, 6);
        expect(v('liq')[2]).toBeCloseTo(131526.56, 6);
    });
});

describe('default_entry_qty with a negative fill price', () => {
    it('10 % of equity: the quantity is negative, truncated toward zero (BINANCE:BTCUSDT 1h)', async () => {
        const v = await run(
            'initial_capital = 100000, default_qty_type = strategy.percent_of_equity, default_qty_value = 10',
            'plot(strategy.default_entry_qty(-close), "q")',
            [[63114.68, 63134.83, 63042, 63075.43]],
            BTC,
        );
        // TradingView: −0.15854 (10,000 / −63,075.43 = −0.1585404…).
        expect(v('q')[0]).toBeCloseTo(-0.15854, 10);
    });

    it('per-contract commission: the signed price stays in the formula (NYMEX:CL1! back-adjusted 1D)', async () => {
        const v = await run(
            'initial_capital = 1000000, default_qty_type = strategy.percent_of_equity, default_qty_value = 10, margin_long = 0, margin_short = 0, commission_type = strategy.commission.cash_per_contract, commission_value = 3',
            `plot(strategy.default_entry_qty(close), "q")
plot(strategy.default_entry_qty(-close), "qn")
plot(strategy.default_entry_qty(-100), "q100")
plot(strategy.default_entry_qty(-1), "q1")`,
            [[-27, -26, -28, -27.52]],
            CL,
        );
        // TradingView: −3, 3, −1 and −100 (100,000 / (−1,000 + 3) = −100.3).
        expect(v('q')[0]).toBe(-3);
        expect(v('qn')[0]).toBe(3);
        expect(v('q100')[0]).toBe(-1);
        expect(v('q1')[0]).toBe(-100);
    });
});
