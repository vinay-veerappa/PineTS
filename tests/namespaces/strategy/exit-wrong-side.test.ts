// SPDX-License-Identifier: AGPL-3.0-only
// A strategy.exit stop / limit on the wrong side of its entry is already breached when the entry
// fills, and fills at once (TradingView, BINANCE:BTCUSDT 1h: an exit placed while flat for a long
// limit entry, its stop 64,066.01 above the 63,974.01 fill, closes the trade at that fill on the
// entry bar). PineTS used to drop such legs.

import { describe, it, expect } from 'vitest';
import { PineTS, Indicator } from '../../../src';

type Bar = [number, number, number, number]; // open, high, low, close

async function run(body: string, ohlc: Bar[]) {
    const bars = ohlc.map(([open, high, low, close], i) => ({ openTime: (i + 1) * 60000, closeTime: (i + 2) * 60000 - 1, open, high, low, close, volume: 1 }));
    const sym = { tickerid: 'TEST:X', ticker: 'X', root: 'X', prefix: 'TEST', type: 'crypto' as const, currency: 'USD', timezone: 'UTC', mintick: 0.01, pointvalue: 1, mincontract: 1, minmove: 1, pricescale: 100, session: '24x7', description: 'X' };
    const provider = { configure() {}, getSymbolInfo: async () => sym, getMarketData: async () => bars };
    const src = `//@version=6
strategy("t", default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 0, margin_short = 0)
${body}`;
    return (await new PineTS(provider, 'TEST:X', '1', bars.length, undefined, bars[bars.length - 1].closeTime).run(new Indicator(src))).strategy!;
}
const flat = (p = 100): Bar => [p, p + 0.5, p - 0.5, p];

describe('exit levels on the wrong side of the entry', () => {
    it('a stop above a long entry fills at the entry fill', async () => {
        // buy limit 102 placed at 100 fills at bar 1's open (100); its stop at 101 is already breached
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long, limit = 102)
    strategy.exit("x", "L", stop = 101)`,
            [flat(), [100, 100.4, 99.6, 100.2], flat(), flat()],
        );
        expect(s.closedtrades.map((t: any) => [t.entry_price, t.exit_id, t.exit_price, t.exit_bar_index])).toEqual([[100, 'x', 100, 1]]);
    });

    it('a take-profit below a long entry fills at the entry fill', async () => {
        const s = await run(
            `if bar_index == 0
    strategy.entry("L", strategy.long, limit = 102)
    strategy.exit("x", "L", limit = 99)`,
            [flat(), [100, 100.4, 99.6, 100.2], flat(), flat()],
        );
        expect(s.closedtrades.map((t: any) => [t.entry_price, t.exit_id, t.exit_price, t.exit_bar_index])).toEqual([[100, 'x', 100, 1]]);
    });
});
