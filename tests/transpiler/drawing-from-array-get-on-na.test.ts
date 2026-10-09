import { describe, expect, it } from 'vitest';
import { PineTS } from 'index';
import { Provider } from '@pinets/marketData/Provider.class';
import { transpile } from '../../src/transpiler/index';

// Repro of the fractal_fxraptor_POI shape: a UDT holds `array<label>`, and a
// setter is called on an element - `obj.labels.get(0).set_textcolor(c)`. The
// element is na whenever `label.new` returned na, which it always does inside a
// request.security secondary context (@silentInSecondary). The `.get(0)` call
// was optional-chained but the setter on its RESULT was not, so the script threw
// "Cannot read properties of null (reading 'set_textcolor')". On TradingView a
// setter on an na drawing does nothing.
describe('a drawing setter on an array element that is na', () => {
    const src = `//@version=6
indicator("drawing-from-array-get-on-na", overlay=true)
type Zone
    array<label> labels
f() =>
    Zone z = Zone.new(array.new<label>())
    z.labels.push(label.new(bar_index, high, "x"))
    z.labels.get(0).set_textcolor(color.red)
    z.labels.get(0).get_text() == "x" ? 1 : 0
s = request.security(syminfo.tickerid, "D", f())
plot(f(), "here")
plot(s, "there")`;

    it('guards the setter on the call result', () => {
        const code = transpile(src).toString();
        expect(code).toMatch(/\?\.get\?\.\(0\)\)\?\.set_textcolor\?\.\(|drawingOrNa\([^;]*\?\.get\?\.\(0\)\)\?*\.set_textcolor/);
    });

    it('runs, and the setter on na does nothing', async () => {
        const pineTS = new PineTS(Provider.Mock, 'BTCUSDC', '60', null, new Date('2024-01-01').getTime(), new Date('2024-01-10').getTime());
        const { plots } = await pineTS.run(src);
        const here = plots['here'].data;
        expect(here.length).toBeGreaterThan(0);
        expect(here[here.length - 1].value).toBe(1);
    });
});
