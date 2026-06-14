import { Side, OrderType } from '@polymarket/clob-client-v2';
import { ethers } from 'ethers';
import config from '../config/index.js';
import { getClient, getClobBalance, getPolygonProvider } from './client.js';
import { hasPosition, addPosition, getPosition, updatePosition, removePosition } from './position.js';
import { fetchMarketByTokenId } from './watcher.js';
import { placeAutoSell } from './autoSell.js';
import { ensureExchangeApproval, CTF_ADDRESS } from './ctf.js';
import { recordSimBuy } from '../utils/simStats.js';
import { TTLCache } from '../utils/cache.js';
import logger from '../utils/logger.js';

const CTF_ABI_BALANCE = ['function balanceOf(address account, uint256 id) view returns (uint256)'];

// ── TTL caches ───────────────────────────────────────────────────────────────
// Market metadata (tickSize, negRisk, conditionId) is immutable per market lifetime.
const _marketOptsCache = new TTLCache({ ttlMs: 300_000, maxSize: 200 });
// CLOB balance changes with every fill; 2s TTL keeps it fresh enough for sizing.
const _balanceCache = new TTLCache({ ttlMs: 2_000, maxSize: 1 });

/** Cached wrapper around getClobBalance() — avoids redundant HTTP calls within a 2s window. */
async function _getCachedBalance() {
    return _balanceCache.get('clobBalance', () => getClobBalance());
}

// Per-market in-flight lock: when a BUY is being executed for a conditionId,
// concurrent signals for the same market are skipped (the in-flight order covers both).
// This replaces the old 500ms batch window, saving ~500ms per trade.
const IN_FLIGHT_LOCK_TIMEOUT_MS = 30_000;
const _inFlightBuys = new Map(); // conditionId → { timer: Timer }

/**
 * Fetch the actual on-chain ERC-1155 balance for a conditional token.
 * Returns shares as a plain float (6-decimal conversion).
 */
export async function getOnChainTokenBalance(tokenId) {
    try {
        const provider = await getPolygonProvider();
        const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI_BALANCE, provider);
        const raw = await ctf.balanceOf(config.proxyWallet, tokenId);
        return parseFloat(ethers.utils.formatUnits(raw, 6));
    } catch (err) {
        logger.warn(`Could not fetch on-chain token balance: ${err.message}`);
        return null;
    }
}

/**
 * Calculate trade size for our entry — independent of the individual fill event.
 *
 * Limit orders can be filled in many small chunks; using the event's fill size
 * would give inconsistent (often sub-minimum) results.
 *
 * SIZE_MODE=percentage → SIZE_PERCENT% of the trader's trade size (copy X% of their bet)
 * SIZE_MODE=balance    → SIZE_PERCENT% of our current USDC.e balance
 */
async function calculateTradeSize(traderSize) {
    if (config.sizeMode === 'percentage') {
        return (traderSize || 0) * (config.sizePercent / 100);
    } else if (config.sizeMode === 'balance') {
        const balance = await _getCachedBalance();
        return balance * (config.sizePercent / 100);
    }
    return 0;
}

/**
 * Get market options (tick size and neg risk) for a token.
 * Results are cached per tokenId with a 5-minute TTL.
 *
 * ON CACHE MISS: returns safe defaults immediately (tickSize 0.01, negRisk false)
 * The CLOB SDK is tried first (authoritative, fast). If the cache is cold,
 * we await the SDK call with a 3s timeout — this ensures the order signature
 * is computed with the correct tick size. Returning blind defaults caused
 * "POLY_1271 signature does not match order hash" errors when the actual
 * market tick size differed from 0.01.
 */
async function getMarketOptions(tokenId) {
    // Fast path: cache hit — return synchronously (peek avoids factory invocation)
    const cached = _marketOptsCache.peek(tokenId);
    if (cached !== undefined) {
        return cached;
    }

    // Cache miss — await the population so we have the real tick size.
    // The CLOB SDK call is typically <200ms; we cap at 3s to avoid hanging.
    try {
        const result = await Promise.race([
            _warmMarketOptsCache(tokenId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
        ]);
        return result;
    } catch (err) {
        // Timeout or error — fall back to safe defaults (tick 0.01 covers most markets)
        logger.warn(`Market-options lookup timed out for ${tokenId?.slice(-8)}, using defaults — some orders may fail signature check`);
        return {
            tickSize: '0.01',
            negRisk: false,
            conditionId: '',
            question: '',
            endDateIso: null,
            active: true,
            acceptingOrders: true,
        };
    }
}

/**
 * Populate the market-options cache in the background.
 * Called without await from getMarketOptions() on cache miss.
 *
 * Tries the CLOB SDK first (authoritative for what the exchange accepts),
 * then falls back to the Gamma API. Applies a 0.01 minimum tick floor —
 * Polymarket's CLOB enforces this for the vast majority of markets.
 */
async function _warmMarketOptsCache(tokenId) {
    return _marketOptsCache.get(tokenId, async () => {
        const client = getClient();
        // ── Primary: CLOB SDK (authoritative) ──────────────────────────
        try {
            const tickSize = await client.getTickSize(tokenId);
            const negRisk = await client.getNegRisk(tokenId);
            const rawTick = parseFloat(String(tickSize));
            const safeTick = String(rawTick >= 0.01 ? rawTick : 0.01);
            return { tickSize: safeTick, negRisk, conditionId: '', question: '', endDateIso: null, active: true, acceptingOrders: true };
        } catch (err) {
            logger.warn('CLOB SDK tick size failed, trying Gamma API:', err.message);
        }

        // ── Fallback: Gamma API (may return optimistic tick sizes) ──────
        try {
            const marketInfo = await fetchMarketByTokenId(tokenId);
            if (marketInfo) {
                const rawTick = parseFloat(marketInfo.orderPriceMinTickSize || '0.01');
                const safeTick = String(rawTick >= 0.01 ? rawTick : 0.01);
                return {
                    tickSize:        safeTick,
                    negRisk:         marketInfo.negRisk || false,
                    conditionId:     marketInfo.conditionId || '',
                    question:        marketInfo.question || '',
                    endDateIso:      marketInfo.endDate || null,
                    active:          marketInfo.active !== false,
                    acceptingOrders: marketInfo.acceptingOrders !== false,
                };
            }
        } catch (err) {
            logger.warn('Gamma API market info failed:', err.message);
        }

        // ── Last resort ────────────────────────────────────────────────
        return { tickSize: '0.01', negRisk: false, conditionId: '', question: '', endDateIso: null, active: true, acceptingOrders: true };
    });
}

/**
 * Execute a BUY trade (copy trader's buy).
 *
 * Uses an in-flight lock to prevent concurrent buys for the same market.
 * If a buy is already executing for this conditionId, the signal is skipped
 * (the in-flight order naturally covers both). The lock auto-clears after
 * 30s to prevent stuck locks from hung executions.
 */
export async function executeBuy(trade) {
    const { tokenId, conditionId } = trade;

    // Get market options (instant — returns defaults on cache miss, warms cache in background)
    const marketOpts = await getMarketOptions(tokenId);
    const effectiveConditionId = conditionId || marketOpts.conditionId;

    if (!effectiveConditionId) {
        logger.warn(`Cannot execute buy — no conditionId for ${trade.market || tokenId}`);
        return;
    }

    // ── In-flight lock: skip if already processing this market ──────────────
    if (_inFlightBuys.has(effectiveConditionId)) {
        logger.info(`Buy already in-flight for ${effectiveConditionId.slice(-8)} — skipping duplicate signal`);
        return;
    }

    // Acquire lock with auto-clear timeout
    const lockTimer = setTimeout(() => {
        logger.warn(`In-flight lock for ${effectiveConditionId.slice(-8)} timed out after ${IN_FLIGHT_LOCK_TIMEOUT_MS / 1000}s — force-clearing`);
        _inFlightBuys.delete(effectiveConditionId);
    }, IN_FLIGHT_LOCK_TIMEOUT_MS);
    _inFlightBuys.set(effectiveConditionId, lockTimer);

    try {
        await _doExecuteBuy(trade, marketOpts, effectiveConditionId);
    } finally {
        clearTimeout(lockTimer);
        _inFlightBuys.delete(effectiveConditionId);
    }
}

/**
 * Round a price to the nearest valid tick increment.
 * For BUY orders (roundUp=true): rounds UP so our bid competes better.
 */
function _roundPriceToTick(price, tickSizeStr, roundUp = true) {
    const tick = parseFloat(tickSizeStr) || 0.01;
    const decimals = Math.max((String(tickSizeStr).split('.')[1] || '').length, 2);
    const rounded = roundUp
        ? Math.ceil(price / tick) * tick
        : Math.floor(price / tick) * tick;
    return parseFloat(rounded.toFixed(decimals));
}

/**
 * Exact-copy mode: our scaled-down trade size is below the CLOB $1 minimum,
 * so we place a GTC limit order matching the trader's actual shares at their
 * price. GTC limit orders don't have the $1 market-order minimum.
 *
 * Polls for fill every 1s with a 30s timeout, then updates the position.
 */
async function _handleBelowMinimumBuy(ctx) {
    const { tokenId, market, price, size, traderUsdc, tradeSize, effectiveMin,
            marketOpts, effectiveConditionId, existingPos, trade } = ctx;

    // Scale to our SIZE_PERCENT, then floor. Minimum 1 share if trader bought at least 1.
    const scaledShares = Math.floor(size * (config.sizePercent / 100));
    const copyShares = scaledShares >= 1 ? scaledShares : (size >= 1 ? 1 : 0);
    const copyUsdc = copyShares * (price || 0);

    if (copyUsdc <= 0 || copyShares <= 0) {
        logger.warn(`Trade size $${tradeSize.toFixed(2)} below $${effectiveMin} minimum — trader order also empty, skipping`);
        return;
    }

    // Cap against position limit
    if (existingPos) {
        const remaining = config.maxPositionSize - (existingPos.totalCost || 0);
        if (copyUsdc > remaining) {
            logger.warn(`Exact-copy $${copyUsdc.toFixed(2)} exceeds remaining cap $${remaining.toFixed(2)} — skipping`);
            return;
        }
    } else if (copyUsdc > config.maxPositionSize) {
        logger.warn(`Exact-copy $${copyUsdc.toFixed(2)} exceeds max position $${config.maxPositionSize} — skipping`);
        return;
    }

    logger.info(`Exact-copy: our calc $${tradeSize.toFixed(2)} < $${effectiveMin} min → GTC limit ${copyShares.toFixed(4)} shares @ $${(price || 0).toFixed(4)} ($${copyUsdc.toFixed(2)})`);

    if (config.dryRun) {
        logger.trade(`[SIM] Exact-copy BUY ${market || tokenId} | ${copyShares.toFixed(4)} sh @ $${(price || 0).toFixed(4)} | outcome: ${trade.outcome || '?'}`);
        if (existingPos) {
            const newShares = existingPos.shares + copyShares;
            const newTotalCost = existingPos.totalCost + copyUsdc;
            updatePosition(effectiveConditionId, { shares: newShares, avgBuyPrice: newTotalCost / newShares, totalCost: newTotalCost });
            logger.info(`[SIM] Exact-copy accumulated: $${newTotalCost.toFixed(2)} / $${config.maxPositionSize}`);
        } else {
            addPosition({ conditionId: effectiveConditionId, tokenId, market: market || marketOpts.question || tokenId, shares: copyShares, avgBuyPrice: price, totalCost: copyUsdc, outcome: trade.outcome });
        }
        recordSimBuy();
        return;
    }

    // Place GTC limit at trader's price + 1% premium (capped at 0.99), rounded to valid tick
    const client = getClient();
    const rawCopyPrice = Math.min((price || 0) * 1.01, 0.99);
    const gtcPrice = _roundPriceToTick(rawCopyPrice, marketOpts.tickSize, true);
    const gtcShares = parseFloat(copyShares.toFixed(4));

    try {
        const resp = await client.createAndPostOrder(
            { tokenID: tokenId, side: Side.BUY, price: gtcPrice, size: gtcShares },
            { tickSize: marketOpts.tickSize, negRisk: marketOpts.negRisk },
            OrderType.GTC,
        );
        if (!resp?.success) {
            logger.warn(`Exact-copy GTC rejected: ${resp?.errorMsg || 'unknown'}`);
            return;
        }
        logger.info(`Exact-copy GTC placed: ${resp.orderID?.slice(-8)} | ${gtcShares.toFixed(4)} sh @ $${gtcPrice.toFixed(4)}`);

        // Poll every 1s for fill (30s timeout)
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1000));
            try {
                const order = await client.getOrder(resp.orderID);
                const matched = parseFloat(order?.size_matched ?? order?.matched_amount ?? '0');
                const status = (order?.status ?? order?.order_status ?? '').toLowerCase();
                if (matched > 0 || status === 'matched' || status === 'filled') {
                    const filledSh = matched > 0 ? matched : gtcShares;
                    const filledCost = filledSh * gtcPrice;
                    logger.success(`Exact-copy filled: ${filledSh.toFixed(4)} shares @ ~$${gtcPrice.toFixed(4)}`);

                    if (existingPos) {
                        const newShares = existingPos.shares + filledSh;
                        const newTotalCost = existingPos.totalCost + filledCost;
                        updatePosition(effectiveConditionId, { shares: newShares, avgBuyPrice: newTotalCost / newShares, totalCost: newTotalCost });
                        logger.success(`Position updated: ${existingPos.market} | total $${newTotalCost.toFixed(2)} / $${config.maxPositionSize}`);
                    } else {
                        addPosition({ conditionId: effectiveConditionId, tokenId, market: market || marketOpts.question || tokenId, shares: filledSh, avgBuyPrice: gtcPrice, totalCost: filledCost, outcome: trade.outcome });
                        try { await ensureExchangeApproval(marketOpts.negRisk); } catch (_) { /* non-critical */ }
                        if (config.autoSellEnabled) {
                            await placeAutoSell(effectiveConditionId, tokenId, filledSh, gtcPrice, marketOpts);
                        }
                    }
                    return;
                }
                if (status === 'cancelled') { logger.warn('Exact-copy GTC cancelled before fill'); return; }
            } catch (_) { /* getOrder can 404 briefly */ }
        }
        try { await client.cancelOrder({ orderID: resp.orderID }); } catch (_) { /* ignore */ }
        logger.warn('Exact-copy GTC did not fill within 30s');
    } catch (err) {
        logger.error(`Exact-copy GTC failed: ${err.message}`);
    }
}

/**
 * Internal: the actual buy logic. Now uses parallel FAK + GTC racing.
 */
async function _doExecuteBuy(trade, marketOpts, effectiveConditionId) {
    const { tokenId, conditionId, market, price, size } = trade;
    if (!marketOpts.active || !marketOpts.acceptingOrders) {
        logger.warn(`Market closed/not accepting orders: ${market || effectiveConditionId} — skipping buy`);
        return;
    }
    // ──────────────────────────────────────────────────────────────────────────

    // Check existing position and max position size cap
    const existingPos = getPosition(effectiveConditionId);
    if (existingPos) {
        const spent = existingPos.totalCost || 0;
        if (spent >= config.maxPositionSize) {
            logger.warn(`Max position $${config.maxPositionSize} reached for: ${market || effectiveConditionId} (spent $${spent.toFixed(2)}). Skipping.`);
            return;
        }
        logger.info(`Adding to existing position (spent $${spent.toFixed(2)} / $${config.maxPositionSize})`);
    }

    // Calculate our trade size: SIZE_PERCENT% of the trader's USDC spend
    // trade.size is in SHARES — convert to USDC: shares × price
    const traderUsdc = (size || 0) * (price || 0);

    // Parallelize: trade size calculation and balance check are independent
    const [tradeSizeRaw, balance] = await Promise.all([
        calculateTradeSize(traderUsdc),
        _getCachedBalance(),
    ]);
    let tradeSize = tradeSizeRaw;

    // Cap so we don't exceed maxPositionSize
    if (existingPos) {
        const remaining = config.maxPositionSize - (existingPos.totalCost || 0);
        tradeSize = Math.min(tradeSize, remaining);
    } else {
        tradeSize = Math.min(tradeSize, config.maxPositionSize);
    }

    // Polymarket enforces a hard $1 minimum per FAK market order.
    // When our scaled-down order would be below this minimum, switch to
    // "exact-copy" mode: place a GTC limit order matching the trader's
    // actual shares and price. GTC limit orders have no $1 minimum.
    const CLOB_MIN_ORDER_USDC = 1;
    const effectiveMin = Math.max(config.minTradeSize, CLOB_MIN_ORDER_USDC);

    if (tradeSize < effectiveMin) {
        await _handleBelowMinimumBuy({
            tokenId, market, price, size, traderUsdc, tradeSize, effectiveMin,
            marketOpts, effectiveConditionId, existingPos, trade,
        });
        return;
    }

    // Balance was already fetched in parallel above — check it now
    if (balance < tradeSize) {
        logger.error(`Insufficient balance: $${balance.toFixed(2)} < $${tradeSize.toFixed(2)} needed`);
        return;
    }

    logger.trade(`BUY ${market || tokenId} | Size: $${tradeSize.toFixed(2)} | Trader price: ${price}`);

    if (config.dryRun) {
        logger.trade(`[SIM] BUY ${market || tokenId} | $${tradeSize.toFixed(2)} @ $${price} | outcome: ${trade.outcome || '?'}`);
        const dryShares = tradeSize / price;
        if (existingPos) {
            const newShares = existingPos.shares + dryShares;
            const newTotalCost = existingPos.totalCost + tradeSize;
            updatePosition(effectiveConditionId, {
                shares: newShares,
                avgBuyPrice: newTotalCost / newShares,
                totalCost: newTotalCost,
            });
            logger.info(`[SIM] Position accumulated: $${newTotalCost.toFixed(2)} / $${config.maxPositionSize}`);
        } else {
            addPosition({
                conditionId: effectiveConditionId,
                tokenId,
                market: market || marketOpts.question || tokenId,
                shares: dryShares,
                avgBuyPrice: price,
                totalCost: tradeSize,
                outcome: trade.outcome,
            });
        }
        recordSimBuy();
        return;
    }

    // ── Parallel FAK + GTC execution ─────────────────────────────────────────
    // Strategy: fire FAK and GTC concurrently. FAK fills instantly if liquidity
    // exists; GTC catches fills when no sellers are present yet. First to fill
    // wins — the other is cancelled. This cuts the "no match → wait → retry" cycle.
    const client = getClient();
    let totalSharesFilled = 0;
    let totalCostFilled = 0;
    let gtcOrderId = null;   // track GTC so we can cancel it if FAK fills first
    let gtcDone = false;     // prevents double-resolution

    const BUY_MAX_RETRIES = config.maxRetries;
    const BUY_RETRY_DELAY = 1000;

    // ── GTC background task ───────────────────────────────────────────────
    const _runGtcBackground = async () => {
        const rawGtc = Math.min(price * 1.02, 0.99);
        const gtcPrice = _roundPriceToTick(rawGtc, marketOpts.tickSize, true);
        const shares = parseFloat((tradeSize / gtcPrice).toFixed(4));

        try {
            const resp = await client.createAndPostOrder(
                { tokenID: tokenId, side: Side.BUY, price: gtcPrice, size: shares },
                { tickSize: marketOpts.tickSize, negRisk: marketOpts.negRisk },
                OrderType.GTC,
            );
            if (!resp?.success) {
                logger.warn(`GTC fallback rejected: ${resp?.errorMsg || 'unknown'}`);
                return null;
            }
            gtcOrderId = resp.orderID;
            logger.info(`GTC placed in parallel: ${gtcOrderId?.slice(-8)} — waiting for fill`);

            // Poll until fill, cancelled, or timeout
            const deadline = Date.now() + config.gtcFallbackTimeout * 1000;
            while (Date.now() < deadline && !gtcDone) {
                await new Promise((r) => setTimeout(r, 2000));
                if (gtcDone) return null; // FAK already filled
                try {
                    const order = await client.getOrder(gtcOrderId);
                    const matched = parseFloat(order?.size_matched ?? order?.matched_amount ?? '0');
                    const status = (order?.status ?? order?.order_status ?? '').toLowerCase();
                    if (matched > 0 || status === 'matched' || status === 'filled') {
                        const filled_ = matched > 0 ? matched : shares;
                        logger.success(`GTC filled in parallel: ${filled_.toFixed(4)} shares @ $${gtcPrice}`);
                        return { sharesFilled: filled_, costFilled: filled_ * gtcPrice };
                    }
                    if (status === 'cancelled') return null;
                } catch (_) { /* getOrder can 404 briefly */ }
            }
            // Timeout — cancel
            try { await client.cancelOrder({ orderID: gtcOrderId }); } catch (_) { /* ignore */ }
            return null;
        } catch (err) {
            logger.warn(`GTC fallback failed: ${err.message}`);
            return null;
        }
    };

    let gtcPromise = null; // started lazily after first FAK "no match"

    // ── FAK retry loop (with parallel GTC) ────────────────────────────────
    for (let attempt = 1; attempt <= BUY_MAX_RETRIES; attempt++) {
        const remainingAmount = tradeSize - totalCostFilled;
        if (remainingAmount < effectiveMin) {
            if (remainingAmount > 0) logger.info(`Remaining $${remainingAmount.toFixed(2)} below $${effectiveMin} minimum — stopping`);
            break;
        }

        logger.info(`Buy attempt ${attempt}/${BUY_MAX_RETRIES} | Amount: $${remainingAmount.toFixed(2)}`);

        try {
            const response = await client.createAndPostMarketOrder(
                { tokenID: tokenId, side: Side.BUY, amount: remainingAmount, orderType: OrderType.FAK },
                { tickSize: marketOpts.tickSize, negRisk: marketOpts.negRisk },
                OrderType.FAK,
            );

            if (response?.success) {
                const sharesFilled = parseFloat(response.takingAmount || '0');
                const costFilled = parseFloat(response.makingAmount || '0');

                if (sharesFilled > 0) {
                    logger.success(`Order filled: ${response.orderID} | ${sharesFilled.toFixed(4)} shares @ ~$${(costFilled / sharesFilled).toFixed(4)}`);
                    totalSharesFilled += sharesFilled;
                    totalCostFilled += costFilled || (sharesFilled * price);
                    // FAK filled — GTC no longer needed
                    if (gtcOrderId) {
                        gtcDone = true;
                        try { await client.cancelOrder({ orderID: gtcOrderId }); } catch (_) { /* ignore */ }
                    }
                    if (tradeSize - totalCostFilled < effectiveMin) break;
                } else {
                    logger.warn(`No liquidity — FAK filled 0 shares (attempt ${attempt})`);
                    // Start parallel GTC after first "no match" if not already running
                    if (!gtcPromise && config.gtcFallbackTimeout > 0) {
                        gtcPromise = _runGtcBackground();
                    }
                }
            } else {
                logger.warn(`Order rejected: ${response?.errorMsg || 'unknown'}`);
            }
        } catch (err) {
            logger.error(`Buy attempt ${attempt} failed: ${err.message}`);
        }

        if (attempt < BUY_MAX_RETRIES && totalCostFilled === 0) {
            await new Promise((r) => setTimeout(r, BUY_RETRY_DELAY));
        }
    }

    // If FAK never filled but GTC was running, wait for its result
    if (totalCostFilled === 0 && gtcPromise) {
        const gtcResult = await gtcPromise;
        if (gtcResult) {
            totalSharesFilled = gtcResult.sharesFilled;
            totalCostFilled = gtcResult.costFilled;
        } else {
            logger.warn(`GTC fallback did not fill within ${config.gtcFallbackTimeout}s`);
        }
    }

    if (totalCostFilled === 0) {
        logger.error(`Failed to fill buy order for ${market || tokenId} after ${BUY_MAX_RETRIES} attempt(s)`);
        return;
    }

    // Calculate avg buy price for this fill
    const fillAvgPrice = totalSharesFilled > 0 ? totalCostFilled / totalSharesFilled : price;

    if (existingPos) {
        // Accumulate into existing position (weighted avg price)
        const newShares = existingPos.shares + totalSharesFilled;
        const newTotalCost = existingPos.totalCost + totalCostFilled;
        const newAvgBuyPrice = newTotalCost / newShares;
        updatePosition(effectiveConditionId, {
            shares: newShares,
            avgBuyPrice: newAvgBuyPrice,
            totalCost: newTotalCost,
        });
        logger.success(`Position updated: ${existingPos.market} | total $${newTotalCost.toFixed(2)} / $${config.maxPositionSize}`);
    } else {
        // New position
        addPosition({
            conditionId: effectiveConditionId,
            tokenId,
            market: market || marketOpts.question || tokenId,
            shares: totalSharesFilled,
            avgBuyPrice: fillAvgPrice,
            totalCost: totalCostFilled,
            outcome: trade.outcome,
        });

        // Ensure the CTF Exchange is approved to move our ERC-1155 tokens (needed for future sells)
        try {
            await ensureExchangeApproval(marketOpts.negRisk);
        } catch (err) {
            logger.warn(`Could not verify ERC-1155 approval: ${err.message}`);
        }

        // Auto-sell only on initial entry, not on accumulation
        if (config.autoSellEnabled) {
            await placeAutoSell(effectiveConditionId, tokenId, totalSharesFilled, fillAvgPrice, marketOpts);
        }
    }
}

/**
 * Execute a SELL trade (copy trader's sell)
 * @param {Object} trade - Trade info from watcher
 */
export async function executeSell(trade) {
    const { tokenId, conditionId, market, price } = trade;

    // Get market options to resolve conditionId
    let effectiveConditionId = conditionId;
    let marketOpts;
    if (!effectiveConditionId) {
        marketOpts = await getMarketOptions(tokenId);
        effectiveConditionId = marketOpts.conditionId;
    }

    // Check if we have a position
    const position = getPosition(effectiveConditionId);
    if (!position) {
        logger.warn(`No position found for: ${market || effectiveConditionId}. Skipping sell.`);
        return;
    }

    if (position.status === 'selling' || position.status === 'sold') {
        logger.warn(`Position already ${position.status}: ${market || effectiveConditionId}. Skipping.`);
        return;
    }

    logger.trade(`SELL ${position.market} | Shares: ${position.shares} | Trader price: ${price}`);

    if (config.dryRun) {
        logger.info('[DRY RUN] Would place sell order');
        removePosition(effectiveConditionId);
        return;
    }

    // Cancel ALL open orders for this token so the CLOB frees up locked balance.
    // Only cancelling by sellOrderId is not enough — the cancel can fail silently
    // and locked tokens cause "not enough balance" on the subsequent sell.
    const client = getClient();
    try {
        const openOrders = await client.getOpenOrders({ asset_id: tokenId });
        if (Array.isArray(openOrders) && openOrders.length > 0) {
            logger.info(`Cancelling ${openOrders.length} open order(s) for token before sell`);
            await Promise.allSettled(
                openOrders.map((o) => client.cancelOrder({ orderID: o.id ?? o.order_id })),
            );
            // Brief pause so the CLOB can update the locked-balance ledger
            await new Promise((r) => setTimeout(r, 600));
        }
    } catch (err) {
        // Fallback: try to cancel just the tracked auto-sell order ID
        if (position.sellOrderId) {
            try {
                await client.cancelOrder({ orderID: position.sellOrderId });
                await new Promise((r) => setTimeout(r, 600));
            } catch (_) { /* ignore */ }
        }
        logger.warn(`Could not fetch open orders to cancel: ${err.message}`);
    }

    updatePosition(effectiveConditionId, { status: 'selling' });

    if (!marketOpts) {
        marketOpts = await getMarketOptions(tokenId);
    }

    // Ensure ERC-1155 approval so the exchange can transfer our tokens
    try {
        await ensureExchangeApproval(marketOpts.negRisk);
    } catch (err) {
        logger.warn(`Could not verify ERC-1155 approval: ${err.message}`);
    }

    // Reconcile stored shares with actual on-chain balance to prevent "not enough balance" errors.
    // The stored amount can be higher than on-chain due to fee deductions or precision drift.
    const onChain = await getOnChainTokenBalance(tokenId);
    let sharesToSell = position.shares;
    if (onChain !== null) {
        if (onChain < 0.0001) {
            logger.warn(`On-chain balance is 0 for ${position.market} — position already sold or redeemed`);
            removePosition(effectiveConditionId);
            return;
        }
        if (onChain < sharesToSell) {
            logger.info(`Adjusting sell amount: stored ${sharesToSell.toFixed(6)} → on-chain ${onChain.toFixed(6)} shares`);
            sharesToSell = onChain;
        }
    }
    // Round down to 4 decimal places to avoid sub-unit precision errors
    sharesToSell = Math.floor(sharesToSell * 10000) / 10000;

    let totalFilledShares = 0;
    let orderPlaced = false;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        try {
            if (config.sellMode === 'market') {
                // Market sell (FAK) — takes what's available at 2% slippage
                logger.info(`Sell attempt ${attempt}/${config.maxRetries} (market) | Shares: ${sharesToSell}`);

                const response = await client.createAndPostMarketOrder(
                    {
                        tokenID: tokenId,
                        side: Side.SELL,
                        amount: sharesToSell * price, // V2: amount is USDC, not shares
                        orderType: OrderType.FAK,
                    },
                    {
                        tickSize: marketOpts.tickSize,
                        negRisk: marketOpts.negRisk,
                    },
                    OrderType.FAK,
                );

                if (response && response.success) {
                    const sharesFilled = parseFloat(response.takingAmount || '0');
                    if (sharesFilled > 0) {
                        logger.success(`Sell filled: ${response.orderID} | ${sharesFilled.toFixed(4)} shares`);
                        totalFilledShares += sharesFilled;
                        // Retry if we still have shares left to sell
                        sharesToSell = Math.max(0, sharesToSell - sharesFilled);
                        if (sharesToSell < 0.0001) break;
                        logger.info(`Partial fill — ${sharesToSell.toFixed(4)} shares remaining to sell`);
                    } else {
                        logger.warn(`No bid liquidity — FAK filled 0 shares (attempt ${attempt})`);
                        break; // no point retrying if no liquidity
                    }
                } else {
                    logger.warn(`Sell rejected: ${response?.errorMsg || 'unknown'}`);
                }
            } else {
                // Limit sell at trader's sell price
                logger.info(`Sell attempt ${attempt}/${config.maxRetries} (limit) | Price: ${price}`);

                const response = await client.createAndPostOrder(
                    {
                        tokenID: tokenId,
                        price: price,
                        size: sharesToSell,
                        side: Side.SELL,
                    },
                    {
                        tickSize: marketOpts.tickSize,
                        negRisk: marketOpts.negRisk,
                    },
                    OrderType.GTC,
                );

                if (response && response.success) {
                    logger.success(`Limit sell placed: ${response.orderID} @ $${price}`);
                    orderPlaced = true;
                    break;
                } else {
                    logger.warn(`Limit sell failed: ${response?.errorMsg || 'Unknown'}`);
                }
            }
        } catch (err) {
            logger.error(`Sell attempt ${attempt} failed:`, err.message);
        }

        if (attempt < config.maxRetries) {
            await new Promise((r) => setTimeout(r, config.retryDelay));
        }
    }

    if (config.sellMode === 'market') {
        if (totalFilledShares > 0) {
            const remaining = position.shares - totalFilledShares;
            if (remaining < 0.0001) {
                removePosition(effectiveConditionId);
                logger.money(`Position fully sold: ${position.market}`);
            } else {
                // Partial fill — update position with remaining shares
                const remainingCost = remaining * position.avgBuyPrice;
                updatePosition(effectiveConditionId, {
                    shares: remaining,
                    totalCost: remainingCost,
                    status: 'open',
                });
                logger.money(`Position partially sold: ${position.market} | ${totalFilledShares.toFixed(4)} filled, ${remaining.toFixed(4)} remaining`);
            }
        } else {
            updatePosition(effectiveConditionId, { status: 'open' });
            logger.error(`Failed to sell ${position.market} after ${config.maxRetries} attempts`);
        }
    } else {
        // Limit sell (GTC) — order placed, fill watcher will handle updates
        if (orderPlaced) {
            updatePosition(effectiveConditionId, { status: 'selling' });
        } else {
            updatePosition(effectiveConditionId, { status: 'open' });
            logger.error(`Failed to place limit sell for ${position.market} after ${config.maxRetries} attempts`);
        }
    }
}
