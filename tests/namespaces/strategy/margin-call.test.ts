import { describe, expect, it } from 'vitest';
import { Context } from '../../../src/Context.class';
import { processMarginCall, processStrategyOrders, initializeStrategy } from '../../../src/namespaces/strategy/utils';
import { Order } from '../../../src/namespaces/strategy/types';
import { Series } from '../../../src/Series';

/**
 * Engine-level regression tests for the TV broker-emulator margin model.
 *
 * Ground truth: QA xlsx exports (BTCUSDT 1D 1% commission "margin_calls",
 * BTCUSDC 1D 0.3% "position_avg_price") where PineTS matches TV to the cent.
 *
 * Two behaviors under test:
 *  1. PARTIAL margin-call liquidation — TV liquidates 4× the contracts
 *     needed to cover the deficit, the cover floored to syminfo.mincontract
 *     (the whole position when the cover is under one step), NOT the whole
 *     position. The remainder stays open. The fill is booked as
 *     "Close position order" / "Margin call", with slippage. Margin 0
 *     disables margin calls and the entry margin check.
 *  2. Reversal close-leg margin semantics — when a reversal entry's OPEN
 *     leg fails the pre-trade margin check, the CLOSE leg still executes.
 */

function makeContext(bar: { open: number; high: number; low: number; close: number }, config: any = {}) {
    const context: any = new Context({
        marketData: [],
        source: [],
        tickerId: 'BTCUSDC',
        timeframe: 'D',
    } as any);
    context.idx = 1;
    context.data.open = new Series([bar.open, bar.open]);
    context.data.high = new Series([bar.high, bar.high]);
    context.data.low = new Series([bar.low, bar.low]);
    context.data.close = new Series([bar.close, bar.close]);
    context.data.openTime = new Series([0, 1000]);
    context.pine = { syminfo: { mintick: 0.01, pointvalue: 1, mincontract: 0.00001 } } as any;
    initializeStrategy(context, config);
    return context;
}

function openShort(context: any, qty: number, entryPrice: number) {
    context.strategy.opentrades.push({
        id: 'trade_0',
        entry_id: 'MacdSE',
        entry_comment: 'MacdSE',
        entry_price: entryPrice,
        entry_bar_index: 0,
        entry_time: 0,
        size: -qty,
        commission: 0,
        max_drawdown: 0,
        max_runup: 0,
        status: 'open',
    });
    context.strategy.position_size = -qty;
    context.strategy.position_avg_price = entryPrice;
    context.strategy.position_entry_name = 'MacdSE';
}

describe('processMarginCall — partial liquidation (TV 4× rule)', () => {
    // Short 5 @ 100,000, capital 540,000, bar high 110,000 (adverse extreme).
    //   equity@110k  = 540,000 + 5×(100,000−110,000) = 490,000
    //   margin@110k  = 5 × 110,000 × 100%             = 550,000
    //   deficit      = 60,000
    //   cover        = 60,000 / 110,000 = 0.54545454… → floored to 0.54545
    //   liquidate    = 4 × 0.54545 = 2.1818  (remainder 2.8182 stays open)
    it('liquidates 4× the floored cover qty at the adverse extreme, remainder stays open', () => {
        const context = makeContext({ open: 101000, high: 110000, low: 99000, close: 105000 }, { initial_capital: 540000 });
        openShort(context, 5, 100000);

        processMarginCall(context);

        const s = context.strategy;
        expect(s.closedtrades.length).toBe(1);
        const closed = s.closedtrades[0];
        expect(Math.abs(closed.size)).toBeCloseTo(2.1818, 9);
        expect(closed.exit_price).toBe(110000);
        expect(closed.exit_id).toBe('Close position order');
        expect(closed.exit_comment).toBe('Margin call');

        expect(s.opentrades.length).toBe(1);
        expect(Math.abs(s.opentrades[0].size)).toBeCloseTo(2.8182, 9);
        expect(s.position_size).toBeCloseTo(-2.8182, 9);

        // Realized loss: 2.1818 contracts × $10,000 adverse move.
        expect(s.netprofit).toBeCloseTo(-2.1818 * 10000, 6);
    });

    it('liquidates one unit when the cover is smaller than one quantity step', () => {
        // capital 599,999.5: deficit = 550,000 − 549,999.5 = 0.5 → cover 0.0000045 < 0.00001.
        // TradingView: 1 share of 159 (AAPL), 1 ES contract of 2 or 4, 1.0 BTC of 1.75417.
        const context = makeContext({ open: 101000, high: 110000, low: 99000, close: 105000 }, { initial_capital: 599999.5 });
        openShort(context, 5, 100000);

        processMarginCall(context);

        const s = context.strategy;
        expect(s.closedtrades.length).toBe(1);
        expect(Math.abs(s.closedtrades[0].size)).toBe(1);
        expect(s.position_size).toBe(-4);
    });

    it('liquidates the whole position when it is smaller than one unit', () => {
        // deficit = 55,000 − (59,999.95 − 5,000) = 0.05 → cover below one step
        const context = makeContext({ open: 101000, high: 110000, low: 99000, close: 105000 }, { initial_capital: 59999.95 });
        openShort(context, 0.5, 100000);

        processMarginCall(context);

        expect(context.strategy.position_size).toBe(0);
    });

    it('applies slippage to the liquidation fill', () => {
        const context = makeContext({ open: 101000, high: 110000, low: 99000, close: 105000 }, { initial_capital: 540000, slippage: 2 });
        openShort(context, 5, 100000);

        processMarginCall(context);

        // buying back a short: 2 ticks above the adverse extreme
        expect(context.strategy.closedtrades[0].exit_price).toBeCloseTo(110000.02, 9);
    });

    it('margin 0 disables margin calls, even with negative equity', () => {
        const context = makeContext({ open: 101000, high: 110000, low: 99000, close: 105000 }, { initial_capital: 10000, margin_long: 0, margin_short: 0 });
        openShort(context, 5, 100000);

        processMarginCall(context);

        expect(context.strategy.closedtrades.length).toBe(0);
        expect(context.strategy.position_size).toBe(-5);
    });

    it('caps the liquidation at the full position for catastrophic deficits', () => {
        // capital 100,000: deficit = 550,000 − 50,000 = 500,000 → 4×cover ≫ 5.
        const context = makeContext({ open: 101000, high: 110000, low: 99000, close: 105000 }, { initial_capital: 100000 });
        openShort(context, 5, 100000);

        processMarginCall(context);

        const s = context.strategy;
        expect(s.closedtrades.length).toBe(1);
        expect(Math.abs(s.closedtrades[0].size)).toBe(5);
        expect(s.closedtrades[0].exit_id).toBe('Close position order');
        expect(s.opentrades.length).toBe(0);
        expect(s.position_size).toBe(0);
    });

    it('does nothing when equity at the adverse extreme covers required margin', () => {
        const context = makeContext({ open: 101000, high: 110000, low: 99000, close: 105000 }, { initial_capital: 2000000 });
        openShort(context, 5, 100000);

        processMarginCall(context);

        const s = context.strategy;
        expect(s.closedtrades.length).toBe(0);
        expect(s.opentrades.length).toBe(1);
        expect(s.position_size).toBe(-5);
    });

    it('runs at 100% margin (no leverage) — full notional collateral is still required', () => {
        // Same as the partial case but asserts the check is NOT skipped at
        // margin_long/margin_short = 100 (a prior bug guarded `>= 100`).
        const context = makeContext({ open: 101000, high: 110000, low: 99000, close: 105000 }, {
            initial_capital: 540000,
            margin_long: 100,
            margin_short: 100,
        });
        openShort(context, 5, 100000);

        processMarginCall(context);
        expect(context.strategy.closedtrades.length).toBe(1);
    });
});

describe('processStrategyOrders — reversal close leg survives margin rejection', () => {
    function makeReversalSetup(initialCapital: number) {
        // Long 5 @ 50,000. Reversal short order qty 10 (close 5 + open 5).
        // Bar open 60,000 → equity = capital + 5×10,000 unrealized.
        // Open leg requires 5 × 60,000 = 300,000.
        const context = makeContext({ open: 60000, high: 61000, low: 59000, close: 60500 }, { initial_capital: initialCapital });
        context.strategy.opentrades.push({
            id: 'trade_0',
            entry_id: 'MacdLE',
            entry_comment: 'MacdLE',
            entry_price: 50000,
            entry_bar_index: 0,
            entry_time: 0,
            size: 5,
            commission: 0,
            max_drawdown: 0,
            max_runup: 0,
            status: 'open',
        });
        context.strategy.position_size = 5;
        context.strategy.position_avg_price = 50000;
        context.strategy.position_entry_name = 'MacdLE';

        const order: Order = {
            id: 'MacdSE',
            direction: -1,
            qty: 10,
            type: 'market',
            bar: 0,
            time: 0,
            status: 'pending',
            category: 'entry',
            comment: 'MacdSE',
            _isReversalEntry: true,
        } as any;
        context.strategy.pending_orders.push(order);
        return context;
    }

    it('margin-rejected open leg: close leg still executes, no new position', () => {
        // equity = 200,000 + 50,000 = 250,000 < 300,000 → open leg rejected.
        const context = makeReversalSetup(200000);
        processStrategyOrders(context);

        const s = context.strategy;
        expect(s.closedtrades.length).toBe(1);
        expect(s.closedtrades[0].exit_price).toBe(60000);
        expect(s.closedtrades[0].exit_id).toBe('MacdSE'); // reversal order id stamps the exit
        expect(s.closedtrades[0].profit).toBeCloseTo(50000, 6);

        expect(s.opentrades.length).toBe(0);   // open leg dropped
        expect(s.position_size).toBe(0);
        expect(s.pending_orders.length).toBe(0); // order consumed, not left pending
    });

    it('sufficient margin: reversal closes old position AND opens the new one', () => {
        // equity = 400,000 + 50,000 = 450,000 ≥ 300,000 → full reversal.
        const context = makeReversalSetup(400000);
        processStrategyOrders(context);

        const s = context.strategy;
        expect(s.closedtrades.length).toBe(1);
        expect(s.opentrades.length).toBe(1);
        expect(s.opentrades[0].size).toBe(-5);
        expect(s.opentrades[0].entry_price).toBe(60000);
        expect(s.position_size).toBe(-5);
    });

    it('margin 0: the reversal opens its new position even when equity is negative', () => {
        // equity = -100,000 + 50,000 = -50,000; no margin model, so nothing is rejected.
        const context = makeReversalSetup(-100000);
        context.strategy.config.margin_long = 0;
        context.strategy.config.margin_short = 0;
        processStrategyOrders(context);

        const s = context.strategy;
        expect(s.closedtrades.length).toBe(1);
        expect(s.opentrades.length).toBe(1);
        expect(s.position_size).toBe(-5);
    });

    it('non-reversal entry with insufficient margin is dropped entirely', () => {
        // Fresh entry from flat: no close leg exists, the order is cancelled.
        const context = makeContext({ open: 60000, high: 61000, low: 59000, close: 60500 }, { initial_capital: 200000 });
        const order: Order = {
            id: 'MacdSE',
            direction: -1,
            qty: 10, // requires 600,000 > 200,000 equity
            type: 'market',
            bar: 0,
            time: 0,
            status: 'pending',
            category: 'entry',
        } as any;
        context.strategy.pending_orders.push(order);

        processStrategyOrders(context);

        const s = context.strategy;
        expect(s.closedtrades.length).toBe(0);
        expect(s.opentrades.length).toBe(0);
        expect(s.pending_orders.length).toBe(0); // cancelled
    });
});
