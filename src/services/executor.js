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

// Per-market buy batching: when multiple BUY signals for the same market arrive
// within BATCH_WINDOW_MS, they're merged into one combined order. This prevents
// the second signal from waiting behind the first (which caused 19s delays).
const BATCH_WINDOW_MS = 500;
const _batchWindows = new Map(); // conditionId → { entries: [], timer: Timer, resolve: fn, promise: Promise }

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
 * Results are cached per tokenId with a 5-minute TTL — market metadata
 * (tickSize, negRisk, conditionId) does not change during a market's lifetime.
 */
async function getMarketOptions(tokenId) {
    return _marketOptsCache.get(tokenId, async () => {
        const client = getClient();
        try {
            const marketInfo = await fetchMarketByTokenId(tokenId);
            if (marketInfo) {
                return {
                    tickSize:        String(marketInfo.orderPriceMinTickSize || '0.01'),
                    negRisk:         marketInfo.negRisk || false,
                    conditionId:     marketInfo.conditionId || '',
                    question:        marketInfo.question || '',
                    endDateIso:      marketInfo.endDate || null,
                    active:          marketInfo.active !== false,
                    acceptingOrders: marketInfo.acceptingOrders !== false,
                };
            }
        } catch (err) {
            logger.warn('Failed to get market info, using defaults:', err.message);
        }

        // Fallback: try SDK methods
        try {
            const tickSize = await client.getTickSize(tokenId);
            const negRisk = await client.getNegRisk(tokenId);
            return { tickSize: String(tickSize), negRisk, conditionId: '', question: '', endDateIso: null, active: true, acceptingOrders: true };
        } catch (err) {
            logger.warn('Failed to get tick size from SDK, using default 0.01');
            return { tickSize: '0.01', negRisk: false, conditionId: '', question: '', endDateIso: null, active: true, acceptingOrders: true };
        }
    });
}

/** Execute a merged batch of buys for the same market. */
async function _executeBatchedBuys(effectiveConditionId, entries) {
    if (entries.length === 0) return;

    // Use marketOpts from the first entry (all same market)
    const marketOpts = entries[0].marketOpts;
    // Merge trades: sum the USDC sizes the trader deployed across all signals
    const mergedTrade = {
        ...entries[0].trade,
        size: entries.reduce((sum, e) => sum + (e.trade.size || 0), 0),
    };

    if (entries.length > 1) {
        logger.info(`Batching ${entries.length} concurrent BUY signals for ${mergedTrade.market || effectiveConditionId}`);
    }

    await _doExecuteBuy(mergedTrade, marketOpts, effectiveConditionId);
}

/**
 * Execute a BUY trade (copy trader's buy).
 * Uses a 500ms batching window — concurrent signals for the same market
 * are merged into one combined order instead of serialized behind each other.
 */
export function executeBuy(trade) {
    const { tokenId, conditionId } = trade;

    // Resolve conditionId to use as batch key.
    return getMarketOptions(tokenId).then((marketOpts) => {
        const effectiveConditionId = conditionId || marketOpts.conditionId;

        // If a batch window is already open for this market, merge into it
        const existing = _batchWindows.get(effectiveConditionId);
        if (existing) {
            clearTimeout(existing.timer);
            existing.entries.push({ trade, marketOpts });
            // Reset the window — wait another BATCH_WINDOW_MS from latest signal
            existing.timer = setTimeout(() => {
                _batchWindows.delete(effectiveConditionId);
                _executeBatchedBuys(effectiveConditionId, existing.entries).then(existing.resolve);
            }, BATCH_WINDOW_MS);
            return existing.promise;
        }

        // Start a new batch window
        let resolveBatch;
        const promise = new Promise((r) => { resolveBatch = r; });
        const batch = {
            entries: [{ trade, marketOpts }],
            timer: setTimeout(() => {
                _batchWindows.delete(effectiveConditionId);
                _executeBatchedBuys(effectiveConditionId, batch.entries).then(resolveBatch);
            }, BATCH_WINDOW_MS),
            resolve: resolveBatch,
            promise,
        };
        _batchWindows.set(effectiveConditionId, batch);
        return promise;
    });
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
    let tradeSize = await calculateTradeSize(traderUsdc);

    // Cap so we don't exceed maxPositionSize
    if (existingPos) {
        const remaining = config.maxPositionSize - (existingPos.totalCost || 0);
        tradeSize = Math.min(tradeSize, remaining);
    } else {
        tradeSize = Math.min(tradeSize, config.maxPositionSize);
    }

    // Polymarket enforces a hard $1 minimum per market order.
    const CLOB_MIN_ORDER_USDC = 1;
    const effectiveMin = Math.max(config.minTradeSize, CLOB_MIN_ORDER_USDC);
    if (tradeSize < effectiveMin) {
        logger.warn(`Trade size $${tradeSize.toFixed(2)} below $${effectiveMin} minimum — skipping buy`);
        return;
    }

    // Check balance (cached within 2s window)
    const balance = await _getCachedBalance();
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
        const gtcPrice = parseFloat(Math.min(price * 1.02, 0.99).toFixed(4));
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
