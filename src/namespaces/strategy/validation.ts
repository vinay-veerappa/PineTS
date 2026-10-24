// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LuxAlgo

// Order arguments TradingView rejects. The messages are TradingView's, without its "Error on bar N: " prefix.

import { PineRuntimeError } from '../../errors/PineRuntimeError';
import { Order, StrategyState } from './types';
import { parseDirection } from './utils';

/** A negative `qty` in strategy.entry / strategy.order (TradingView RE10024; 0 places nothing). */
export function checkOrderQty(fn: 'strategy.entry' | 'strategy.order', qty: unknown): void {
    if (typeof qty === 'number' && qty < 0) {
        throw new PineRuntimeError(`Invalid \`qty\` value (${qty}) in the \`${fn}()\` call. Use a positive number less or equal to 1000000000000.`, fn);
    }
}

/**
 * `qty_percent` outside (0, 100] in strategy.exit, or outside [0, 100] in strategy.close, whose message
 * also names strategy.exit (TradingView RE10025). An na value is absent.
 */
export function checkQtyPercent(fn: 'strategy.exit' | 'strategy.close', pct: unknown): void {
    if (typeof pct !== 'number' || Number.isNaN(pct)) return;
    if (pct > 100 || pct < 0 || (pct === 0 && fn === 'strategy.exit')) {
        throw new PineRuntimeError(
            `Invalid \`qty_percent\` value (${pct}) in the \`strategy.exit()\` call. Use a positive value less than or equal to 100 for this parameter.`,
            fn,
        );
    }
}

/**
 * Re-placing a pending strategy.entry / strategy.order id with the other direction, on the same bar or a
 * later one (TradingView RE10028). The message names the command that placed the pending order.
 */
export function checkPendingDirection(fn: 'strategy.entry' | 'strategy.order', strategy: StrategyState, id: string, dir: number): void {
    const pending = strategy.pending_orders.find(
        (o: Order) => (o.category === 'entry' || o.category === undefined) && !(o as any)._risk && o.id === id && o.status === 'pending' && parseDirection(o.direction) !== dir,
    );
    if (!pending) return;
    const placedBy = pending.category === 'entry' ? 'strategy.entry' : 'strategy.order';
    const side = (d: number) => (d === 1 ? 'long' : 'short');
    const from = side(parseDirection(pending.direction));
    const to = side(dir);
    throw new PineRuntimeError(
        `The '${placedBy}' call already generated an order with the '${id}' ID in the '${from}' direction, which cannot be changed to '${to}'. ` +
            `Cancel the existing '${id}' order and create a new order in the desired direction, or specify a different 'id' for the '${to}' order.`,
        fn,
    );
}

/**
 * strategy.exit needs a price leg: `profit`, `limit`, `loss` or `stop`, or `trail_offset` with `trail_price` /
 * `trail_points` (TradingView compile error CE10042; a leg given as na counts). Raised when the call runs.
 */
export function checkExitLegs(parsed: Record<string, unknown>): void {
    const given = (k: string) => parsed[k] !== undefined;
    if (['profit', 'limit', 'loss', 'stop'].some(given) || (given('trail_offset') && (given('trail_price') || given('trail_points')))) return;
    throw new PineRuntimeError(
        'strategy.exit must have at least one of the following parameters: "profit", "limit", "loss", "stop" or one of the following pairs: ' +
            '"trail_offset" and "trail_price" / "trail_points". To close the position at market price, use "strategy.close"',
        'strategy.exit',
    );
}
