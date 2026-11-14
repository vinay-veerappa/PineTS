import { describe, expect, it } from 'vitest';
import { transpile } from '../../src/transpiler';
import { PineRuntimeError } from '../../src/errors/PineRuntimeError';
import {
    MAX_COMPILER_LINE_CODE_UNITS,
    MAX_COMPILER_LINES,
    MAX_COMPILER_NESTING,
    MAX_COMPILER_SOURCE_BYTES,
    MAX_COMPILER_SOURCE_CODE_UNITS,
    MAX_COMPILER_TOKENS,
} from '../../src/transpiler/analysis/CompilerBudget';

const H = '//@version=6\nindicator("budget")\n';

// The limits are read from CompilerBudget, not copied: this vendored host sizes them for
// its own indicator library (see the note there), and the gate must keep measuring the
// configured cap instead of a number that has since moved.
describe('compiler structural budget', () => {
    it('rejects oversized source before lexing', () => {
        expect(() => transpile(H + `//${'a'.repeat(MAX_COMPILER_SOURCE_CODE_UNITS + 1)}\nplot(close)`)).toThrow(PineRuntimeError);
        // Each repeat is 1 003 code units and 3 003 UTF-8 bytes, so this passes the code-unit
        // cap and trips the byte cap.
        const repeats = Math.ceil(MAX_COMPILER_SOURCE_BYTES / 3_000);
        const multibyte = H + (`//${'界'.repeat(1_000)}\n`).repeat(repeats) + 'plot(close)';
        expect(() => transpile(multibyte)).toThrow(/source bytes/);
    });

    it('rejects excessive line count and line length', () => {
        expect(() => transpile(H + '\n'.repeat(MAX_COMPILER_LINES + 1) + 'plot(close)')).toThrow(PineRuntimeError);
        expect(() => transpile(H + `//${'a'.repeat(MAX_COMPILER_LINE_CODE_UNITS + 1)}\nplot(close)`)).toThrow(PineRuntimeError);
    });

    it('rejects excessive source nesting before recursive parsing', () => {
        const depth = MAX_COMPILER_NESTING + 1;
        const source = H + `plot(${'('.repeat(depth)}close${')'.repeat(depth)})`;
        expect(() => transpile(source)).toThrow(PineRuntimeError);
    });

    it('rejects excessive tokens before Pine parsing', () => {
        // Four tokens per `x=1;`, one thousand statements per line so neither the line cap
        // nor the line-length cap is what trips.
        const perLine = 1_000;
        const lines = Math.ceil((MAX_COMPILER_TOKENS + 1) / (4 * perLine));
        const source = H + ('x=1;'.repeat(perLine) + '\n').repeat(lines);
        expect(() => transpile(source)).toThrow(/token count/);
    });

    it('continues to compile ordinary Pine', () => {
        expect(() => transpile(H + 'plot(close)')).not.toThrow();
    });
});
