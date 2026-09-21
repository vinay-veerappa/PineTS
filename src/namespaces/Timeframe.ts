import { Series } from '../Series';
import { alignToTimeframe, normalizeTimeframe as normalizeTFFromTime } from './Time';
import { canonicalizeTimeframe, parseTimeframe, timeframeToSeconds } from '../timeframe';
const TF_UNITS = ['S', 'D', 'W', 'M'];

/** Canonical Pine spelling. Delegates to the shared parser — see src/timeframe.ts. */
function normalizeTF(tf: string): string {
    if (!tf) return tf;
    return canonicalizeTimeframe(tf);
}

export class Timeframe {
    private _normalized: string | null = null;

    constructor(private context: any) {}

    param(source: any, index: number = 0, name?: string) {
        return Series.from(source).get(index);
    }

    /** Normalized canonical timeframe (cached) */
    private get normalized(): string {
        if (this._normalized === null) {
            this._normalized = normalizeTF(this.context.timeframe);
        }
        return this._normalized;
    }

    /** Last character of the normalized timeframe (uppercase) */
    private get unit(): string {
        return this.normalized.slice(-1).toUpperCase();
    }

    //Note : current PineTS implementation does not differentiate between main_period and period because the timeframe is always taken from the main execution context.
    //once we implement indicator() function, the main_period can be overridden by the indicator's timeframe.
    public get main_period() {
        return this.normalized;
    }
    public get period() {
        return this.normalized;
    }

    public get multiplier() {
        const val = parseInt(this.normalized);
        return isNaN(val) ? 1 : val;
    }

    public get isdwm() {
        return ['D', 'W', 'M'].includes(this.unit);
    }
    public get isdaily() {
        return this.unit === 'D';
    }
    public get isweekly() {
        return this.unit === 'W';
    }
    public get ismonthly() {
        return this.unit === 'M';
    }
    public get isseconds() {
        return this.unit === 'S';
    }
    public get isminutes() {
        //minutes timeframes are pure integers (no unit suffix)
        return /^\d+$/.test(this.normalized);
    }

    public get isintraday() {
        return !this.isdwm;
    }

    /**
     * Detects changes in the specified timeframe.
     * Returns true on the first bar of a new HTF period, false otherwise.
     *
     * Works by aligning current and previous bar timestamps to the target
     * timeframe and comparing — if they differ, a new period has started.
     */
    public change(timeframe: any): boolean {
        const tf = typeof timeframe === 'function' ? timeframe() : timeframe;
        const resolved = tf instanceof Series ? tf.get(0) : tf;
        const normalizedTarget = normalizeTFFromTime(resolved || '');
        if (!normalizedTarget) return false;

        const currentTime = Series.from(this.context.data.openTime).get(0);
        const prevTime = Series.from(this.context.data.openTime).get(1);

        if (isNaN(currentTime) || isNaN(prevTime)) return false;

        const currentAligned = alignToTimeframe(currentTime, normalizedTarget);
        const prevAligned = alignToTimeframe(prevTime, normalizedTarget);

        return currentAligned !== prevAligned;
    }
    public from_seconds(seconds: number) {
        if (seconds < 60) {
            //valid seconds timeframes are 1, 5, 15, 30, 45, everything in between should be rounded to the next valid timeframe
            const roundedSeconds = Math.ceil(seconds / 5) * 5;
            return roundedSeconds + 'S';
        }
        if (seconds < 60 * 60 * 24) {
            const roundedMinutes = Math.ceil(seconds / 60);
            return roundedMinutes;
        }
        //check whole weeks first
        if (seconds <= 60 * 60 * 24 * 7 * 52) {
            //is whole weeks ?
            if (seconds % (60 * 60 * 24 * 7) === 0) {
                const roundedWeeks = Math.ceil(seconds / (60 * 60 * 24 * 7));
                return roundedWeeks + 'W';
            }

            //whole days
            const roundedHours = Math.ceil(seconds / (60 * 60 * 24));
            return roundedHours + 'D';
        }

        return '12M';
    }
    public in_seconds(timeframe?: string) {
        const tf = timeframe === undefined || timeframe === null ? this.normalized : timeframe;
        return timeframeToSeconds(tf);
    }
}
