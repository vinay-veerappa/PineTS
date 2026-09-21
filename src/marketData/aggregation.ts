// SPDX-License-Identifier: AGPL-3.0-only

import { Kline } from './types';
import { parseTimeframe, timeframeToSeconds } from '../timeframe';

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Given a target timeframe and a set of supported timeframes, select the
 * best sub-timeframe to aggregate from.
 *
 * Strategy:
 * - **W/M targets**: always use `'D'` (calendar-based grouping).
 * - **All others**: pick the largest supported timeframe whose duration
 *   evenly divides the target duration.
 *
 * @returns The best sub-timeframe, or `null` if none found.
 */
export function selectSubTimeframe(
    targetTimeframe: string,
    supportedTimeframes: Set<string>,
): string | null {
    // Week and month targets are CALENDAR periods, not durations: a month is 28-31 days,
    // so no fixed ratio of sub-candles can express one. They are always grouped from
    // daily bars by calendar key instead (see `_aggregateByWeek` / `_aggregateByMonth`).
    const targetSpec = parseTimeframe(targetTimeframe);
    if (!targetSpec) return null;
    if (targetSpec.unit === 'W' || targetSpec.unit === 'M') {
        return supportedTimeframes.has('D') ? 'D' : null;
    }

    const targetSeconds = targetSpec.seconds;

    // Candidates come from what the PROVIDER actually serves, ordered by real duration.
    // Deriving the order here (rather than filtering a hard-coded list) is what lets an
    // arbitrary target like '90' or '720' find a sub-timeframe: previously a target
    // absent from the lookup table scored `undefined` and bailed, even when the provider
    // served a timeframe that divides it exactly.
    const candidates = [...supportedTimeframes]
        .map(tf => ({ tf, spec: parseTimeframe(tf) }))
        .filter(({ spec }) => {
            if (!spec) return false;
            // A calendar period can never be a fixed-ratio divisor of a duration.
            if (spec.unit === 'W' || spec.unit === 'M') return false;
            return spec.seconds < targetSeconds && targetSeconds % spec.seconds === 0;
        })
        .sort((a, b) => a.spec!.seconds - b.spec!.seconds);

    if (candidates.length === 0) return null;

    // Pick the largest divisor — fewest sub-candles to fetch and merge
    return candidates[candidates.length - 1].tf;
}

/**
 * Compute how many sub-candles fit into one aggregated candle.
 *
 * For fixed-duration aggregation: `targetSeconds / subSeconds`.
 * For calendar-based (W/M from D): returns `Infinity` to signal variable grouping.
 */
export function getAggregationRatio(targetTimeframe: string, subTimeframe: string): number {
    const targetSpec = parseTimeframe(targetTimeframe);
    if (targetSpec && (targetSpec.unit === 'W' || targetSpec.unit === 'M')) {
        return Infinity; // Calendar-based grouping — variable bars per group
    }
    const targetSec = timeframeToSeconds(targetTimeframe);
    const subSec = timeframeToSeconds(subTimeframe);
    if (!targetSec || !subSec) return Infinity;
    return targetSec / subSec;
}

/**
 * Aggregate sub-candles into higher-timeframe candles.
 *
 * Three modes:
 * 1. **Fixed-ratio** (intraday → higher intraday): groups every N consecutive
 *    sub-candles, with session-boundary detection to avoid cross-session merging.
 * 2. **Weekly from daily**: groups daily bars by ISO week number.
 * 3. **Monthly from daily**: groups daily bars by calendar year+month.
 *
 * OHLCV merge:
 * - `open` = first sub-candle's open
 * - `high` = max of all highs
 * - `low`  = min of all lows
 * - `close` = last sub-candle's close
 * - `volume` = sum
 * - `closeTime` = last sub-candle's closeTime (preserves session-aware close)
 */
export function aggregateCandles(
    subCandles: Kline[],
    targetTimeframe: string,
    subTimeframe: string,
): Kline[] {
    if (subCandles.length === 0) return [];

    const targetSpec = parseTimeframe(targetTimeframe);
    if (targetSpec?.unit === 'W') {
        return _aggregateByWeek(subCandles, targetSpec.multiplier);
    }
    if (targetSpec?.unit === 'M') {
        return _aggregateByMonth(subCandles, targetSpec.multiplier);
    }

    // Fixed-ratio aggregation with session-boundary detection
    const ratio = getAggregationRatio(targetTimeframe, subTimeframe);
    return _aggregateByRatio(subCandles, ratio);
}

// ── Internal helpers ────────────────────────────────────────────────────

/**
 * Fixed-ratio aggregation with session-boundary detection.
 *
 * Starts a new group whenever:
 * - The current group has `ratio` bars, OR
 * - The time gap between consecutive bars exceeds 1.5× the expected sub-candle
 *   duration (indicates an overnight/weekend/holiday gap for stocks;
 *   transparent for 24/7 crypto where gaps don't occur).
 */
function _aggregateByRatio(candles: Kline[], ratio: number): Kline[] {
    if (candles.length === 0) return [];

    const result: Kline[] = [];
    let group: Kline[] = [candles[0]];

    // Expected gap between consecutive sub-candles (ms).
    // Use the median of the first few gaps to be robust against a single outlier.
    const expectedGapMs = _estimateExpectedGap(candles);
    const maxGapMs = expectedGapMs > 0 ? expectedGapMs * 1.5 : 0;

    for (let i = 1; i < candles.length; i++) {
        const gap = candles[i].openTime - candles[i - 1].openTime;
        const isSessionBreak = maxGapMs > 0 && gap > maxGapMs;

        if (isSessionBreak || group.length >= ratio) {
            result.push(_mergeGroup(group));
            group = [];
        }
        group.push(candles[i]);
    }

    if (group.length > 0) {
        result.push(_mergeGroup(group));
    }

    return result;
}

/**
 * Group daily candles into `multiplier`-week bars.
 *
 * Buckets are ANCHORED, not merely consecutive: the key is the Monday-aligned week
 * ordinal divided by the multiplier, so a '2W' bar always covers the same pair of
 * calendar weeks no matter where the loaded data happens to start. Chunking the
 * groups in arrival order instead would shift every bucket when the start date moved,
 * which makes two runs over overlapping ranges disagree about the same bar.
 */
function _aggregateByWeek(dailyCandles: Kline[], multiplier: number = 1): Kline[] {
    const keyOf = multiplier <= 1
        ? (t: number) => _getISOWeekKey(t)
        : (t: number) => String(Math.floor(_weekOrdinal(t) / multiplier));
    return _groupByKey(dailyCandles, keyOf);
}

/**
 * Group daily candles into `multiplier`-month bars.
 *
 * Anchored to the calendar the same way as weeks: the month ordinal
 * (`year * 12 + month`) divided by the multiplier, so '3M' yields real calendar
 * quarters (Jan-Mar, Apr-Jun, ...) rather than three months counted from whenever
 * the data starts.
 */
function _aggregateByMonth(dailyCandles: Kline[], multiplier: number = 1): Kline[] {
    return _groupByKey(dailyCandles, (t: number) => {
        const d = new Date(t);
        const ordinal = d.getUTCFullYear() * 12 + d.getUTCMonth();
        return multiplier <= 1 ? String(ordinal) : String(Math.floor(ordinal / multiplier));
    });
}

/** Merge runs of candles that share a bucket key. */
function _groupByKey(candles: Kline[], keyOf: (openTime: number) => string): Kline[] {
    const groups: Kline[][] = [];
    let currentGroup: Kline[] = [];
    let currentKey = '';

    for (const candle of candles) {
        const key = keyOf(candle.openTime);
        if (key !== currentKey && currentGroup.length > 0) {
            groups.push(currentGroup);
            currentGroup = [];
        }
        currentKey = key;
        currentGroup.push(candle);
    }
    if (currentGroup.length > 0) groups.push(currentGroup);

    return groups.map(_mergeGroup);
}

/**
 * Whole weeks since the Monday on/before the epoch.
 *
 * 1970-01-01 was a THURSDAY, so dividing the raw timestamp by a week would put the
 * boundary on a Thursday. Shift back to Monday 1969-12-29 first.
 */
const MONDAY_BEFORE_EPOCH_MS = -3 * 86_400_000;
function _weekOrdinal(timestampMs: number): number {
    return Math.floor((timestampMs - MONDAY_BEFORE_EPOCH_MS) / 604_800_000);
}

/** Merge a group of candles into a single aggregated candle. */
function _mergeGroup(group: Kline[]): Kline {
    const first = group[0];
    const last = group[group.length - 1];

    let high = first.high;
    let low = first.low;
    let volume = 0;
    let quoteAssetVolume = 0;
    let numberOfTrades = 0;
    let takerBuyBaseAssetVolume = 0;
    let takerBuyQuoteAssetVolume = 0;

    for (let i = 0; i < group.length; i++) {
        const c = group[i];
        if (c.high > high) high = c.high;
        if (c.low < low) low = c.low;
        volume += c.volume;
        quoteAssetVolume += c.quoteAssetVolume;
        numberOfTrades += c.numberOfTrades;
        takerBuyBaseAssetVolume += c.takerBuyBaseAssetVolume;
        takerBuyQuoteAssetVolume += c.takerBuyQuoteAssetVolume;
    }

    return {
        openTime: first.openTime,
        open: first.open,
        high,
        low,
        close: last.close,
        volume,
        closeTime: last.closeTime,
        quoteAssetVolume,
        numberOfTrades,
        takerBuyBaseAssetVolume,
        takerBuyQuoteAssetVolume,
        ignore: 0,
    };
}

/**
 * Estimate the expected gap (ms) between consecutive sub-candles.
 * Uses the minimum gap among the first few pairs — this naturally
 * picks the intra-session gap and ignores overnight/weekend gaps.
 */
function _estimateExpectedGap(candles: Kline[]): number {
    if (candles.length < 2) return 0;

    const samplesToCheck = Math.min(candles.length - 1, 20);
    let minGap = Infinity;

    for (let i = 0; i < samplesToCheck; i++) {
        const gap = candles[i + 1].openTime - candles[i].openTime;
        if (gap > 0 && gap < minGap) minGap = gap;
    }

    return minGap === Infinity ? 0 : minGap;
}

/** Return "YYYY-WNN" ISO week key for a UTC timestamp. */
function _getISOWeekKey(timestampMs: number): string {
    const d = new Date(timestampMs);
    const dayNum = d.getUTCDay() || 7; // Make Sunday = 7
    d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Set to nearest Thursday
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${weekNo}`;
}
