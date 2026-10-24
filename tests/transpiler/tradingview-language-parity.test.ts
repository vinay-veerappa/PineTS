import { describe, it, expect } from 'vitest';
import { PineTS } from '../../src/PineTS.class';
import { Provider } from '@pinets/marketData/Provider.class';

// Language constructs that diverged from TradingView. Each script plots the raw series it depends
// on, so the expected value on every bar is computed here by hand; the semantics were checked on
// TradingView with the same constructs (e.g. a rising edge through `(expr)[1]` fires on exactly
// the bars a rising edge through a variable does, inside `and`, `or` and `?:` alike).

async function run(body: string) {
    const src = `//@version=6
indicator("language parity")
${body}
plot(bar_index, "bi")
plot(close, "c")
plot(open, "o")`;
    const pineTS = new PineTS(Provider.Mock, 'BTCUSDC', '60', null, new Date('2024-01-01').getTime(), new Date('2024-01-03').getTime());
    const { plots } = await pineTS.run(src);
    const times: number[] = plots['bi'].data.map((d: any) => d.time);
    expect(times.length).toBeGreaterThan(40);
    const series = (title: string): number[] => {
        expect(plots[title], `plot "${title}"`).toBeDefined();
        const byTime = new Map(plots[title].data.map((d: any) => [d.time, d.value]));
        return times.map((t) => (byTime.has(t) ? (byTime.get(t) as number) : NaN));
    };
    return { series, close: series('c'), open: series('o'), n: times.length };
}

const isNa = (v: number) => v === null || v === undefined || Number.isNaN(v);

describe('UDT fields declared without a type annotation', () => {
    it('infers int, float, bool and string fields from their defaults', async () => {
        const { series } = await run(`
type T
    a = 3
    b = false
    c = 1.5
    s = "xy"
    neg = -2
    float typed = 0.25
t = T.new()
t2 = T.new(a = 10)
plot(t.a + 1, "a")
plot(t.b ? 1 : 0, "b")
plot(t.c * 2, "c2")
plot(str.length(t.s), "s")
plot(t.neg, "neg")
plot(t.typed, "typed")
plot(t2.a, "a2")`);
        expect(series('a').every((v) => v === 4)).toBe(true);
        expect(series('b').every((v) => v === 0)).toBe(true);
        expect(series('c2').every((v) => v === 3)).toBe(true);
        expect(series('s').every((v) => v === 2)).toBe(true);
        expect(series('neg').every((v) => v === -2)).toBe(true);
        expect(series('typed').every((v) => v === 0.25)).toBe(true);
        expect(series('a2').every((v) => v === 10)).toBe(true);
    });
});

describe('switch expression assigned with :=', () => {
    it('reads built-in series and other variables inside the arms', async () => {
        const { series, close, open } = await run(`
mode = input.string("T", "mode", options = ["P", "T"])
var float x = na
y = 7.0
x := switch mode
    "P" => 1.0
    => y - (close - open)
plot(x, "x")`);
        series('x').forEach((v, i) => expect(v, `bar ${i}`).toBeCloseTo(7 - (close[i] - open[i]), 8));
    });

    it('resolves a two-level UDT member chain inside an arm', async () => {
        const { series } = await run(`
type S
    bool buy = false
type C
    S signals
var C cc = C.new(signals = S.new(true))
mode = input.string("T", "mode", options = ["P", "T"])
bool chain = false
chain := switch mode
    "P" => false
    => cc.signals.buy
plot(chain ? 1 : 0, "chain")`);
        expect(series('chain').every((v) => v === 1)).toBe(true);
    });

    it('works inside a function and inside an if / else-if block', async () => {
        const { series, close } = await run(`
mode = input.string("T", "mode", options = ["P", "T"])
f() =>
    float r = 0.0
    r := switch mode
        "P" => 0.0
        => close * 2
    r
var float z = na
if bar_index < 0
    z := 0.0
else if true
    z := 5.0
    z := switch mode
        "P" => 1.0
        => z + close
plot(f(), "f")
plot(z, "z")`);
        series('f').forEach((v, i) => expect(v, `bar ${i}`).toBeCloseTo(close[i] * 2, 8));
        series('z').forEach((v, i) => expect(v, `bar ${i}`).toBeCloseTo(5 + close[i], 8));
    });
});

describe('switch arm whose value is an if expression', () => {
    it('returns the value of the taken branch', async () => {
        const { series, close, open, n } = await run(`
mode = input.string("T", "mode", options = ["P", "T"])
bool v = switch mode
    "P" => false
    =>
        if bar_index < 0
            false
        else
            close > open
float w = switch mode
    "P" => 0.0
    =>
        float k = close * 2
        if bar_index % 3 == 0
            k
        else if bar_index % 3 == 1
            -k
        else
            0.0
float noElse = switch mode
    "P" => 0.0
    =>
        if bar_index % 2 == 0
            1.0
float noDiscriminant = switch
    bar_index < 0 => -1.0
    =>
        if close > open
            1.0
        else
            2.0
plot(v ? 1 : 0, "v")
plot(w, "w")
plot(noElse, "noElse")
plot(noDiscriminant, "noDiscriminant")`);
        const v = series('v'), w = series('w'), noElse = series('noElse'), nd = series('noDiscriminant');
        for (let i = 0; i < n; i++) {
            expect(v[i], `v bar ${i}`).toBe(close[i] > open[i] ? 1 : 0);
            expect(w[i], `w bar ${i}`).toBeCloseTo(i % 3 === 0 ? close[i] * 2 : i % 3 === 1 ? -close[i] * 2 : 0, 8);
            if (i % 2 === 0) expect(noElse[i], `noElse bar ${i}`).toBe(1);
            else expect(isNa(noElse[i]), `noElse bar ${i}`).toBe(true);
            expect(nd[i], `noDiscriminant bar ${i}`).toBe(close[i] > open[i] ? 1 : 2);
        }
    });
});

describe('history of a parenthesized expression in a lazy operand', () => {
    it('records the series on every bar inside and / or / ?: and in a function', async () => {
        const { series, close, open, n } = await run(`
bool gate = bar_index % 3 == 0
edgeFn() => close > open and not (close > open)[1]
plot((gate and (close > open)[1]) ? 1 : 0, "and")
plot((not gate or (close > open)[1]) ? 1 : 0, "or")
plot((gate ? (close > open)[1] : false) ? 1 : 0, "tern")
plot((close > open and not (close > open)[1]) ? 1 : 0, "edge")
plot(edgeFn() ? 1 : 0, "edgeFn")`);
        const up = (i: number) => close[i] > open[i];
        const and = series('and'), or = series('or'), tern = series('tern'), edge = series('edge'), edgeFn = series('edgeFn');
        let edges = 0;
        for (let i = 1; i < n; i++) {
            const gate = i % 3 === 0;
            expect(and[i], `and bar ${i}`).toBe(gate && up(i - 1) ? 1 : 0);
            expect(or[i], `or bar ${i}`).toBe(!gate || up(i - 1) ? 1 : 0);
            expect(tern[i], `tern bar ${i}`).toBe(gate && up(i - 1) ? 1 : 0);
            expect(edge[i], `edge bar ${i}`).toBe(up(i) && !up(i - 1) ? 1 : 0);
            expect(edgeFn[i], `edgeFn bar ${i}`).toBe(up(i) && !up(i - 1) ? 1 : 0);
            edges += edge[i];
        }
        // the series has more than one rising edge, so a stale history would show
        expect(edges).toBeGreaterThan(2);
    });
});

describe('str.match', () => {
    it('returns the matched text, or "" when nothing matches', async () => {
        const { series } = await run(`
hit = str.match("abc{close[9]}def", "\\\\{\\\\w+\\\\[\\\\s*\\\\d+\\\\s*\\\\]\\\\}")
miss = str.match("abc", "z+")
plot(str.length(hit), "hitLen")
plot(miss == "" ? 1 : 0, "missEmpty")
plot(str.length(miss), "missLen")`);
        expect(series('hitLen').every((v) => v === 10)).toBe(true);
        expect(series('missEmpty').every((v) => v === 1)).toBe(true);
        expect(series('missLen').every((v) => v === 0)).toBe(true);
    });
});

describe('bool()', () => {
    it('is false for false', async () => {
        const { series } = await run(`
bool f = false
plot(bool(f) ? 1 : 0, "boolVar")
plot(bool(false) ? 1 : 0, "boolLit")
plot(bool(true) ? 1 : 0, "boolTrue")
plot(bool(0) ? 1 : 0, "boolZero")
plot(bool(1) ? 1 : 0, "boolOne")
plot(bool(na) ? 1 : 0, "boolNa")`);
        expect(series('boolVar').every((v) => v === 0)).toBe(true);
        expect(series('boolLit').every((v) => v === 0)).toBe(true);
        expect(series('boolTrue').every((v) => v === 1)).toBe(true);
        expect(series('boolZero').every((v) => v === 0)).toBe(true);
        expect(series('boolOne').every((v) => v === 1)).toBe(true);
        expect(series('boolNa').every((v) => v === 0)).toBe(true);
    });
});
