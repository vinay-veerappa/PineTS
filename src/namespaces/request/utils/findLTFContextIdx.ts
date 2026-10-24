// SPDX-License-Identifier: AGPL-3.0-only

export function findLTFContextIdx(
    myOpenTime: number,
    myCloseTime: number,
    openTime: number[],
    closeTime: number[],
    lookahead: boolean = false,
    mainContextEDate?: number,
    gaps: boolean = false
): number {
    // Find the latest intrabar that is fully contained within the chart bar [myOpenTime, myCloseTime]
    for (let i = openTime.length - 1; i >= 0; i--) {
        if (closeTime[i] <= myCloseTime && openTime[i] >= myOpenTime) {
            // Found the last intrabar for this chart bar.
            // lookahead=true returns the FIRST intrabar of the chart bar, with or without gaps
            // (TradingView, historical bars: 5m request on a 60m chart).
            if (lookahead) {
                let j = i;
                while (j > 0 && openTime[j - 1] >= myOpenTime) j--;
                return j;
            }

            // lookahead=false: return the last intrabar
            return i;
        }

        // Optimization: if the bar closes before our bar opens, we went too far back
        if (closeTime[i] < myOpenTime) {
            break;
        }
    }

    return -1;
}
