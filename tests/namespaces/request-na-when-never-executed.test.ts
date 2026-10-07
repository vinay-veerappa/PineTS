import { describe, expect, it } from 'vitest';
import { PineTS } from 'index';
import { Provider } from '@pinets/marketData/Provider.class';

// A request.security issued inside a user function whose calling condition
// depends on the context's OWN symbol. The primary runs as chart 'BTCUSDC'
// where the condition is true, but the secondary runs the script AS the
// requested symbol ('OTHER') where the condition is false and the expression's
// param never registers. The read-back must be na (TradingView: plot shows na;
// v6 dynamic requests only execute when their calling condition is true),
// not a TypeError on the missing params entry.
describe('request.security', () => {
    it('reads na when the expression never executed in the secondary context', async () => {
        const src = `//@version=6
indicator("sec-never-executed")
enabled = syminfo.ticker != "OTHER"
reqHi(string symbol, bool en) =>
    if en
        request.security(symbol, "", high)
    else
        float(na)
hi = reqHi("OTHER", enabled)
plot(hi, "hi")
`;
        const pineTS = new PineTS(Provider.Mock, 'BTCUSDC', '60', null, new Date('2024-01-01').getTime(), new Date('2024-01-10').getTime());
        const { plots } = await pineTS.run(src);

        const data = plots['hi'].data;
        expect(data.length).toBeGreaterThan(0);
        // Every bar: the expression never registered in the secondary (its own
        // gate is false there), so the chart-side read is na.
        for (const d of data) expect(Number.isNaN(d.value)).toBe(true);
    });
});