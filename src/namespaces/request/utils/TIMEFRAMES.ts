// SPDX-License-Identifier: AGPL-3.0-only

import { canonicalizeTimeframe, parseTimeframe } from '../../../timeframe';

/**
 * The timeframes that used to be the ONLY ones `request.security` would accept.
 *
 * Kept as an exported constant because it is part of the public surface and tests pin
 * it, but it is no longer a gate: `isValidTimeframe` parses instead of looking up, so
 * '720' (12h), '90', '2D' and seconds timeframes are all accepted now. Ordering is no
 * longer taken from this array's index either — see `compareTimeframes`, which uses real
 * durations. An index-based order can only rank timeframes somebody remembered to list.
 */
//Pine Script Timeframes (canonical format: minutes as integers, D/W/M for day/week/month)
export const TIMEFRAMES = ['1', '3', '5', '15', '30', '45', '60', '120', '180', '240', 'D', 'W', 'M'];

/**
 * Normalize a timeframe string to the canonical Pine Script format.
 * Handles '1h', '4h', '12h', '1d', '1w', '1D', '1W', '1M', '30S', etc.
 * Unparseable input is returned unchanged, so callers keep control of the error.
 */
export function normalizeTimeframe(tf: string): string {
    return canonicalizeTimeframe(tf);
}

/** Whether a string denotes a timeframe at all. Replaces `TIMEFRAMES.indexOf(tf) !== -1`. */
export function isValidTimeframe(tf: string): boolean {
    return parseTimeframe(tf) !== null;
}
