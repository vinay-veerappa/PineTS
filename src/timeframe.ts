// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Timeframe parsing — the single source of truth for what a timeframe string means.
 *
 * Before this module every layer carried its own hard-coded table of the timeframes it
 * recognised, and the tables disagreed: `request.security` accepted 13 strings, the
 * aggregator knew 18, and the seconds lookup knew 18 more. A timeframe present in one
 * table and absent from another failed in whichever layer was missing it, so `'90'` — a
 * perfectly ordinary 90-minute chart — returned zero bars even where the provider served
 * 1-minute data that divides it exactly.
 *
 * ## Canonical form (what TradingView / Pine Script itself uses)
 *
 * | Unit    | Canonical            | Notes                                        |
 * |---------|----------------------|----------------------------------------------|
 * | seconds | `'1S'`, `'30S'`      | always carries the `S`                       |
 * | minutes | `'1'`, `'60'`, `'720'` | BARE INTEGER. Hours are minutes: 3h = `'180'` |
 * | days    | `'D'`, `'2D'`        | multiplier 1 is written bare                 |
 * | weeks   | `'W'`, `'2W'`        | multiplier 1 is written bare                 |
 * | months  | `'M'`, `'3M'`        | multiplier 1 is written bare                 |
 *
 * ## The case trap
 *
 * `'1M'` is one MONTH and `'1m'` is one MINUTE. Anything that lowercases a timeframe
 * before matching turns a monthly chart into a 1-minute one. Parse case-sensitively for
 * the `M`/`m` pair and only then fall back to case-insensitive matching for `S/D/W/H`,
 * which are unambiguous.
 */

export type TimeframeUnit = 'S' | 'm' | 'D' | 'W' | 'M';

export interface TimeframeSpec {
    /** How many of `unit`. Always >= 1. */
    multiplier: number;
    /** `'m'` is minutes; `'M'` is months. */
    unit: TimeframeUnit;
    /** Canonical Pine spelling — see the table above. */
    canonical: string;
    /**
     * Duration in seconds. Months use a 30-day approximation and weeks a 7-day one, which
     * is exact enough for the only two things seconds are used for: ordering two
     * timeframes, and deciding whether one divides another. Never use it as a calendar.
     */
    seconds: number;
}

const SECONDS_PER: Record<TimeframeUnit, number> = {
    S: 1,
    m: 60,
    D: 86_400,
    W: 604_800,
    M: 2_592_000, // 30d approximation — ordering/divisibility only
};

/** `<digits><unit-letter>` or bare `<digits>` (minutes) or a bare unit letter (multiplier 1). */
const TF_PATTERN = /^(\d*)\s*([A-Za-z]?)$/;

/**
 * Parse a timeframe string into its parts, or `null` if it is not a timeframe.
 *
 * Accepts canonical Pine (`'240'`, `'D'`, `'30S'`) and the common non-canonical spellings
 * people actually type (`'4h'`, `'1d'`, `'1W'`, `'12h'`). Returns `null` rather than
 * guessing, so callers can fail loudly.
 */
export function parseTimeframe(tf: string | number | null | undefined): TimeframeSpec | null {
    if (tf === null || tf === undefined) return null;

    const raw = String(tf).trim();
    if (raw === '') return null;

    const m = TF_PATTERN.exec(raw);
    if (!m) return null;

    const [, digits, letterRaw] = m;

    // Bare integer → minutes. This is the canonical Pine spelling for everything
    // from 1 minute to 1440 minutes, and it is why hours have no unit letter.
    if (letterRaw === '') {
        if (digits === '') return null;
        const n = parseInt(digits, 10);
        return n > 0 ? makeSpec(n, 'm') : null;
    }

    const multiplier = digits === '' ? 1 : parseInt(digits, 10);
    if (!(multiplier > 0)) return null;

    // CASE-SENSITIVE first, and only for the M/m pair: 'M' is months, 'm' is minutes.
    // Getting this wrong silently reinterprets a monthly chart as a 1-minute one.
    if (letterRaw === 'M') return makeSpec(multiplier, 'M');
    if (letterRaw === 'm') {
        // Bare 'm' with no multiplier is not a TradingView timeframe at all, so it is
        // pure ambiguity. Every normalizer this module replaced resolved it to months
        // (they uppercased a lone letter), and there is a test pinning that, so keep it.
        // Note this makes 'm' months while '1m' is one minute — inherited, not designed.
        if (digits === '') return makeSpec(1, 'M');
        return makeSpec(multiplier, 'm');
    }

    // The rest are unambiguous, so case does not matter.
    switch (letterRaw.toUpperCase()) {
        case 'S':
            return makeSpec(multiplier, 'S');
        case 'D':
            return makeSpec(multiplier, 'D');
        case 'W':
            return makeSpec(multiplier, 'W');
        // 'h' is not Pine canonical, but it is what people type. Fold it into minutes
        // so '4h' and '240' are the same timeframe rather than two near-misses.
        case 'H':
            return makeSpec(multiplier * 60, 'm');
        default:
            return null;
    }
}

function makeSpec(multiplier: number, unit: TimeframeUnit): TimeframeSpec {
    return {
        multiplier,
        unit,
        canonical: toCanonical(multiplier, unit),
        seconds: multiplier * SECONDS_PER[unit],
    };
}

function toCanonical(multiplier: number, unit: TimeframeUnit): string {
    if (unit === 'm') return String(multiplier);
    if (unit === 'S') return `${multiplier}S`;
    // D / W / M: a multiplier of 1 is written bare ('D', not '1D')
    return multiplier === 1 ? unit : `${multiplier}${unit}`;
}

/**
 * Canonical Pine spelling of a timeframe, or the input unchanged if it is unparseable.
 *
 * Returning the input rather than throwing preserves the behaviour every existing
 * `normalizeTimeframe` had — callers decide what an unknown timeframe means.
 */
export function canonicalizeTimeframe(tf: string): string {
    return parseTimeframe(tf)?.canonical ?? tf;
}

/** Duration in seconds, or `0` if unparseable (so falsy checks keep working). */
export function timeframeToSeconds(tf: string | number | null | undefined): number {
    return parseTimeframe(tf)?.seconds ?? 0;
}

/** True when `tf` denotes a whole day or longer (Pine's `timeframe.isdwm`). */
export function isDWM(tf: string): boolean {
    const spec = parseTimeframe(tf);
    return spec !== null && (spec.unit === 'D' || spec.unit === 'W' || spec.unit === 'M');
}

/**
 * Compare two timeframes by duration. Negative when `a` is shorter than `b`.
 *
 * This replaces comparing positions in a hard-coded ordered list, which could only ever
 * order the timeframes somebody had remembered to put in the list.
 */
export function compareTimeframes(a: string, b: string): number {
    return timeframeToSeconds(a) - timeframeToSeconds(b);
}
