// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import {
    parseTimeframe,
    canonicalizeTimeframe,
    timeframeToSeconds,
    compareTimeframes,
    isDWM,
} from '../../src/timeframe';
import { selectSubTimeframe, getAggregationRatio, aggregateCandles } from '../../src/marketData/aggregation';
import { MockProvider } from '../../src/marketData/Mock/MockProvider.class';
import { PineTS } from '../../src/PineTS.class';
import { BinanceProvider } from '../../src/marketData/Binance/BinanceProvider.class';
import { AlpacaProvider } from '../../src/marketData/Alpaca/AlpacaProvider.class';
import { FMPProvider } from '../../src/marketData/FMP/FMPProvider.class';

describe('timeframe parser', () => {
    it('parses canonical Pine spellings', () => {
        expect(parseTimeframe('1')).toMatchObject({ multiplier: 1, unit: 'm', seconds: 60 });
        expect(parseTimeframe('240')).toMatchObject({ unit: 'm', seconds: 14400 });
        expect(parseTimeframe('30S')).toMatchObject({ multiplier: 30, unit: 'S', seconds: 30 });
        expect(parseTimeframe('D')).toMatchObject({ multiplier: 1, unit: 'D', seconds: 86400 });
        expect(parseTimeframe('2D')).toMatchObject({ multiplier: 2, unit: 'D' });
        expect(parseTimeframe('W')).toMatchObject({ multiplier: 1, unit: 'W' });
        expect(parseTimeframe('3M')).toMatchObject({ multiplier: 3, unit: 'M' });
    });

    it('parses the non-canonical spellings people actually type', () => {
        expect(canonicalizeTimeframe('1h')).toBe('60');
        expect(canonicalizeTimeframe('3h')).toBe('180');
        expect(canonicalizeTimeframe('12h')).toBe('720');
        expect(canonicalizeTimeframe('4H')).toBe('240');
        expect(canonicalizeTimeframe('5m')).toBe('5');
        expect(canonicalizeTimeframe('1d')).toBe('D');
        expect(canonicalizeTimeframe('1W')).toBe('W');
        expect(canonicalizeTimeframe('5s')).toBe('5S');
    });

    // The single most dangerous input in this module: lowercasing before matching
    // turns a MONTHLY chart into a 1-minute one, quietly.
    it('keeps 1M (month) and 1m (minute) apart', () => {
        expect(parseTimeframe('1M')!.unit).toBe('M');
        expect(parseTimeframe('1m')!.unit).toBe('m');
        expect(timeframeToSeconds('1M')).toBe(2592000);
        expect(timeframeToSeconds('1m')).toBe(60);
    });

    // NEGATIVE CONTROL - a parser that accepts everything is not a parser.
    it('rejects non-timeframes instead of guessing', () => {
        for (const bad of ['', '   ', 'xyz', '0', '-5', '1.5', 'D5', '5X', '1h30m', 'close']) {
            expect(parseTimeframe(bad), 'expected rejection: ' + JSON.stringify(bad)).toBeNull();
        }
        expect(timeframeToSeconds('xyz')).toBe(0);
        // Unparseable input passes through unchanged, so callers own the error.
        expect(canonicalizeTimeframe('xyz')).toBe('xyz');
    });

    it('orders by duration, including timeframes no whitelist ever listed', () => {
        expect(compareTimeframes('60', 'D')).toBeLessThan(0);
        expect(compareTimeframes('720', '240')).toBeGreaterThan(0);
        expect(compareTimeframes('90', '60')).toBeGreaterThan(0);
        expect(compareTimeframes('1440', 'D')).toBe(0);
        expect(compareTimeframes('30S', '1')).toBeLessThan(0);
    });

    it('classifies day-or-longer as dwm', () => {
        expect(['D', '2D', 'W', 'M', '3M'].every(isDWM)).toBe(true);
        expect(['1', '720', '1440', '30S'].some(isDWM)).toBe(false);
    });
});

describe('sub-timeframe selection', () => {
    const supported = new Set(['1', '5', '15', '60', '240', 'D', 'W', 'M']);

    it('finds a divisor for targets absent from any hard-coded list', () => {
        // These are the cases that returned null before the parser landed: the target
        // was missing from TIMEFRAME_SECONDS, so the lookup was undefined and bailed.
        expect(selectSubTimeframe('720', supported)).toBe('240'); // 12h from 4h
        expect(selectSubTimeframe('480', supported)).toBe('240'); // 8h  from 4h
        expect(selectSubTimeframe('180', supported)).toBe('60'); // 3h  from 1h
        expect(selectSubTimeframe('90', supported)).toBe('15'); // 90m from 15m
        expect(selectSubTimeframe('7', supported)).toBe('1'); // 7m  from 1m
        expect(selectSubTimeframe('2D', supported)).toBe('D');
    });

    it('picks the LARGEST divisor, to fetch the fewest sub-candles', () => {
        expect(selectSubTimeframe('240', supported)).toBe('60');
        expect(getAggregationRatio('240', '60')).toBe(4);
        expect(getAggregationRatio('720', '240')).toBe(3);
    });

    it('routes calendar periods through daily, never a fixed ratio', () => {
        expect(selectSubTimeframe('W', supported)).toBe('D');
        expect(selectSubTimeframe('2W', supported)).toBe('D');
        expect(selectSubTimeframe('3M', supported)).toBe('D');
        expect(getAggregationRatio('2W', 'D')).toBe(Infinity);
    });

    it('returns null when nothing divides the target - it does not guess', () => {
        // Seconds are the real restriction: no bundled provider serves sub-minute bars,
        // so a seconds timeframe has nothing to aggregate FROM. This must stay a clean
        // null rather than silently rounding up to 1 minute.
        expect(selectSubTimeframe('30S', supported)).toBeNull();
        expect(selectSubTimeframe('1S', supported)).toBeNull();
        // ...but it works the moment a provider does serve seconds.
        expect(selectSubTimeframe('30S', new Set(['1S', '15S', '1']))).toBe('15S');
        // 7m cannot come from 5m - 420 is not divisible by 300.
        expect(selectSubTimeframe('7', new Set(['5', '15']))).toBeNull();
        expect(selectSubTimeframe('xyz', supported)).toBeNull();
    });
});

describe('multi-period calendar aggregation', () => {
    const day = 86_400_000;
    const mkDaily = (startISO: string, n: number) =>
        Array.from({ length: n }, (_, i) => {
            const t = new Date(startISO).getTime() + i * day;
            return {
                openTime: t,
                open: i,
                high: i,
                low: i,
                close: i,
                volume: 1,
                closeTime: t + day - 1,
                quoteAssetVolume: 0,
                numberOfTrades: 0,
                takerBuyBaseAssetVolume: 0,
                takerBuyQuoteAssetVolume: 0,
                ignore: 0,
            } as any;
        });

    it('groups 2W on the same calendar boundary regardless of where data starts', () => {
        // Start on a Monday and on the Wednesday of the same week. An anchored bucket
        // puts both into the same 2-week bar; chunking in arrival order would not, and
        // two overlapping runs would then disagree about the same bar.
        const fromMon = aggregateCandles(mkDaily('2024-01-01T00:00:00Z', 28), '2W', 'D');
        const fromWed = aggregateCandles(mkDaily('2024-01-03T00:00:00Z', 26), '2W', 'D');
        expect(new Date(fromMon[0].openTime).toISOString()).toBe('2024-01-01T00:00:00.000Z');
        // Both series' SECOND bucket must begin on the same calendar date.
        expect(new Date(fromMon[1].openTime).toISOString()).toBe('2024-01-15T00:00:00.000Z');
        expect(new Date(fromWed[1].openTime).toISOString()).toBe('2024-01-15T00:00:00.000Z');
    });

    it('groups 3M into real calendar quarters', () => {
        const bars = aggregateCandles(mkDaily('2024-01-01T00:00:00Z', 200), '3M', 'D');
        const starts = bars.map((b) => new Date(b.openTime).toISOString().slice(0, 7));
        expect(starts[0]).toBe('2024-01'); // Jan-Mar
        expect(starts[1]).toBe('2024-04'); // Apr-Jun
        expect(starts[2]).toBe('2024-07');
    });

    it('still groups plain W and M one period at a time', () => {
        const weekly = aggregateCandles(mkDaily('2024-01-01T00:00:00Z', 21), 'W', 'D');
        expect(weekly).toHaveLength(3);
        const monthly = aggregateCandles(mkDaily('2024-01-01T00:00:00Z', 90), 'M', 'D');
        expect(monthly).toHaveLength(3);
    });
});

describe('aggregated bars match native bars', () => {
    it('4h aggregated from the 1h fixture equals the native 4h fixture', async () => {
        const s = new Date('2024-01-01').getTime();
        const e = new Date('2024-02-01').getTime();

        const native: any[] = await (new MockProvider() as any).getMarketData('BTCUSDC', '240', undefined, s, e);

        class OnlyHourly extends MockProvider {
            protected getSupportedTimeframes() {
                return new Set(['60']);
            }
        }
        const agg: any[] = await (new OnlyHourly() as any).getMarketData('BTCUSDC', '240', undefined, s, e);

        expect(native.length).toBeGreaterThan(100);
        expect(agg.length).toBe(native.length);

        const byTime = new Map(native.map((k) => [k.openTime, k]));
        const lastOpenTime = agg[agg.length - 1].openTime;
        let compared = 0;
        for (const a of agg) {
            const n = byTime.get(a.openTime);
            // The final bar is clipped by the range end, so the aggregate sees only the
            // sub-candles inside the window while the native bar is whole. Skip it.
            if (!n || a.openTime === lastOpenTime) continue;
            expect(a.open).toBe(n.open);
            expect(a.high).toBe(n.high);
            expect(a.low).toBe(n.low);
            expect(a.close).toBe(n.close);
            compared++;
        }
        expect(compared).toBeGreaterThan(100);
    });
});

// A gate, not an assertion about today's values: every timeframe any provider CLAIMS to
// serve must be one the parser understands. These used to be independent hand-maintained
// tables, and an entry added to one and missed in another failed only at runtime, on that
// timeframe, as zero bars.
describe('provider timeframe declarations stay parseable', () => {
    const providers: [string, any][] = [
        ['Mock', new MockProvider()],
        ['Binance', new BinanceProvider()],
        ['Alpaca', new AlpacaProvider()],
        ['FMP', new FMPProvider()],
    ];

    for (const [name, instance] of providers) {
        it(name + ' declares only parseable, canonical timeframes', () => {
            const declared: Set<string> = (instance as any).getSupportedTimeframes();
            expect(declared.size).toBeGreaterThan(0);
            for (const tf of declared) {
                expect(parseTimeframe(tf), name + ' declares unparseable timeframe ' + JSON.stringify(tf)).not.toBeNull();
                // Declared timeframes must be in CANONICAL form, or `supported.has(...)`
                // in BaseProvider misses them after the request side canonicalizes.
                expect(canonicalizeTimeframe(tf), name + ' declares non-canonical ' + JSON.stringify(tf)).toBe(tf);
            }
        });
    }
});


// The host (Vela, and the Schwab stream behind it) INJECTS a duck-typed provider and
// serves the chart's own bars - PineTS' bundled marketData providers are bypassed
// entirely. That is how 15s/30s bars reach Pine. What used to break was PineTS' own
// understanding of a seconds timeframe: `request.security` looked the chart timeframe up
// in a 13-entry array that had no seconds in it, scored -1, and threw "Invalid timeframe"
// before any data was touched.
describe('seconds timeframes through an injected provider', () => {
    const START = Date.UTC(2024, 4, 6, 13, 30, 0);

    const mkKlines = (n: number, stepSec: number) =>
        Array.from({ length: n }, (_, i) => {
            const t = START + i * stepSec * 1000;
            const base = 100 + Math.sin(i / 7) * 5;
            return {
                openTime: t, open: base, high: base + 1, low: base - 1, close: base + 0.5,
                volume: 10, closeTime: t + stepSec * 1000 - 1, quoteAssetVolume: 0,
                numberOfTrades: 0, takerBuyBaseAssetVolume: 0, takerBuyQuoteAssetVolume: 0, ignore: 0,
            };
        });

    const providerFor = (chartTf: string, stepSec: number) => ({
        getMarketData: async (_sym?: string, tf?: string) =>
            !tf || tf === chartTf ? mkKlines(400, stepSec) : mkKlines(400, 60),
        getSymbolInfo: async () => ({
            ticker: 'NQ', tickerid: 'NQ', mintick: 0.25, pointvalue: 20, timezone: 'America/New_York',
        }),
    });

    const code = `
//@version=6
indicator("sec")
plot(timeframe.in_seconds(), "tf_secs")
plot(timeframe.isseconds ? 1 : 0, "is_sec")
plot(timeframe.change("1") ? 1 : 0, "minute_edge")
plot(request.security("NQ", "1", close), "m1")
`;

    it.each([
        ['15s', 15, 100, 3],
        ['30s', 30, 200, 1],
    ])('%s: built-ins resolve and request.security reaches a 1m series', async (tf, stepSec, minutes, leadingNaN) => {
        const pine = new PineTS(providerFor(tf, stepSec) as never, 'NQ', tf, 400);
        await pine.ready();
        const ctx: any = await pine.run(code);
        const P = ctx.plots;

        expect(P['tf_secs'].data[0].value).toBe(stepSec);
        expect(P['is_sec'].data[0].value).toBe(1);

        // 400 bars of `stepSec` spans `minutes` minutes, so that many minute boundaries
        // are crossed (the first bar opens one). Before the parser landed this used
        // `parseInt('15s')` = 15 MINUTES and the count was wrong by orders of magnitude.
        const edges = P['minute_edge'].data.filter((d: any) => d.value === 1).length;
        expect(edges).toBe(minutes - 1);

        // request.security must RESOLVE (it used to throw "Invalid timeframe"), and must
        // be na only for the leading bars inside the first still-forming 1m bar -
        // lookahead_off cannot see an unclosed HTF bar.
        const m1 = P['m1'].data.map((d: any) => Number(d.value));
        const nanIdx = m1.map((v: number, i: number) => (Number.isNaN(v) ? i : -1)).filter((i: number) => i >= 0);
        expect(nanIdx).toEqual(Array.from({ length: leadingNaN }, (_, i) => i));
        expect(Number.isNaN(m1[leadingNaN])).toBe(false);
    });
});
