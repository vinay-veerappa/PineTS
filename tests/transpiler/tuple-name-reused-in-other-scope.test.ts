import { describe, expect, it } from 'vitest';
import { PineTS } from 'index';
import { Provider } from '@pinets/marketData/Provider.class';

// Repro of the fractal_fxraptor_POI shape. Tuple destructuring registers each
// element name in a GLOBAL set, and the transformer's only guard against a
// same-named variable elsewhere was "the init is a computed member expression"
// - which Pine's own `high[0]` also is. So `[h0, t0] = g()` anywhere made
// `float h0 = high[0]` in any other function compile to
// `$.get($.let.high, 0)[0]`, throwing "Cannot read properties of undefined
// (reading '0')" on the first bar.
describe('a tuple element name reused as a plain variable in another scope', () => {
    it('reads the series, not a tuple temp', async () => {
        const src = `//@version=6
indicator("tuple-name-reuse")
g() => [high, time]
f() =>
    [h0, t0] = g()
    h0
other() =>
    float h0 = high[0]
    int t0 = time[0]
    h0 + (t0 > 0 ? 0 : 1)
plot(f(), "tuple")
plot(other(), "plain")`;
        const pineTS = new PineTS(Provider.Mock, 'BTCUSDC', '60', null, new Date('2024-01-01').getTime(), new Date('2024-01-10').getTime());
        const { plots } = await pineTS.run(src);

        const tuple = plots['tuple'].data;
        const plain = plots['plain'].data;
        expect(plain.length).toBeGreaterThan(0);
        // both read the bar's high: the destructured path and the plain one agree
        for (let i = 0; i < plain.length; i++) {
            expect(plain[i].value).toBe(tuple[i].value);
        }
        expect(plain[plain.length - 1].value).not.toBeNaN();
    });
});
