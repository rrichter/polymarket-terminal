import { Side, OrderType } from '@polymarket/clob-client-v2';
import { ethers } from 'ethers';
import config from '../config/index.js';
import { getClient, getClobBalance, getPolygonProvider } from './client.js';
import { hasPosition, addPosition, getPosition, updatePosition, removePosition } from './position.js';
import { fetchMarketByTokenId } from './watcher.js';
import { placeAutoSell } from './autoSell.js';
import { ensureExchangeApproval, CTF_ADDRESS } from './ctf.js';
import { recordSimBuy } from '../utils/simStats.js';
import logger from '../utils/logger.js';

const CTF_ABI_BALANCE = ['function balanceOf(address account, uint256 id) view returns (uint256)'];

// Per-market buy queue: prevents concurrent buys for the same market.
// Each conditionId maps to the Promise tail of its queue so calls are
// chained — the next buy only starts after the previous one finishes.
const _buyQueue = new Map();

/**
 * Fetch the actual on-chain ERC-1155 balance for a conditional token.
 * Returns shares as a plain float (6-decimal conversion).
 */
async function getOnChainTokenBalance(tokenId) {
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
 * SIZE_MODE=percentage → SIZE_PERCENT% of MAX_POSITION_SIZE per market
 * SIZE_MODE=balance    → SIZE_PERCENT% of our current USDC.e balance
 */
async function calculateTradeSize() {
    if (config.sizeMode === 'percentage') {
        return config.maxPositionSize * (config.sizePercent / 100);
    } else if (config.sizeMode === 'balance') {
        const balance = await getClobBalance();
        return balance * (config.sizePercent / 100);
    }
    return 0;
}

/**
 * Get market options (tick size and neg risk) for a token
 */
async function getMarketOptions(tokenId) {
    const client = getClient();
    try {
        // Try to get from market info
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
}

/**
 * Execute a BUY trade (copy trader's buy).
 * Calls are serialized per market — concurrent events for the same market
 * are queued and processed one at a time to prevent duplicate positions.
 */
export function executeBuy(trade) {
    const { tokenId, conditionId } = trade;

    // Resolve conditionId to use as queue key.
    // getMarketOptions is a read-only fetch — safe to run outside the queue.
    const queued = getMarketOptions(tokenId).then((marketOpts) => {
        const effectiveConditionId = conditionId || marketOpts.conditionId;

        // Chain this buy after the previous one for the same market
        const prev = _buyQueue.get(effectiveConditionId) ?? Promise.resolve();
        const current = prev
            .then(() => _doExecuteBuy(trade, marketOpts, effectiveConditionId))
            .finally(() => {
                // Remove from map only if we're still the tail (no newer call queued)
                if (_buyQueue.get(effectiveConditionId) === current) {
                    _buyQueue.delete(effectiveConditionId);
                }
            });
        _buyQueue.set(effectiveConditionId, current);
        return current;
    });

    return queued;
}

/**
 * GTC fallback for when FAK finds no liquidity (e.g. trader buys into "next market"
 * before any sellers exist). Places a GTC limit order and polls until filled or timeout.
 *
 * Returns { sharesFilled, costFilled } on success, or null on failure/timeout.
 */
async function _tryGtcFallback(client, tokenId, tradeSize, price, marketOpts) {
    const gtcPrice = parseFloat(Math.min(price * 1.02, 0.99).toFixed(4));
    const shares   = parseFloat((tradeSize / gtcPrice).toFixed(4));

    logger.info(`No liquidity via FAK — placing GTC limit buy: ${shares} shares @ $${gtcPrice}`);

    let orderId;
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
        orderId = resp.orderID;
        logger.info(`GTC order placed: ${orderId} — waiting for fill (up to ${config.gtcFallbackTimeout}s)...`);
    } catch (err) {
        logger.warn(`GTC fallback order failed: ${err.message}`);
        return null;
    }

    const deadline    = Date.now() + config.gtcFallbackTimeout * 1000;
    const pollMs      = 3000;

    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        try {
            const order = await client.getOrder(orderId);
            const matched = parseFloat(order?.size_matched ?? order?.matched_amount ?? '0');
            const status  = (order?.status ?? order?.order_status ?? '').toLowerCase();

            if (matched > 0 || status === 'matched' || status === 'filled') {
                const sharesFilled = matched > 0 ? matched : shares;
                const costFilled   = sharesFilled * gtcPrice;
                logger.success(`GTC filled: ${sharesFilled.toFixed(4)} shares @ $${gtcPrice} | orderID: ${orderId}`);
                return { sharesFilled, costFilled };
            }

            // Order gone from open orders also means it was matched
            if (status === 'cancelled') {
                logger.warn(`GTC order ${orderId} was cancelled externally`);
                return null;
            }
        } catch { /* getOrder can 404 briefly — keep polling */ }
    }

    // Timed out — cancel the GTC
    logger.warn(`GTC order ${orderId} not filled in ${config.gtcFallbackTimeout}s — cancelling`);
    try { await client.cancelOrder({ orderID: orderId }); } catch { /* ignore */ }
    return null;
}

/**
 * Internal: the actual buy logic, guaranteed to run serially per market.
 */
async function _doExecuteBuy(trade, marketOpts, effectiveConditionId) {
    const { tokenId, conditionId, market, price, size } = trade;

    // ── Market expiry guard ────────────────────────────────────────────────────
    if (!marketOpts.active || !marketOpts.acceptingOrders) {
        logger.warn(`Market closed/not accepting orders: ${market || effectiveConditionId} — skipping buy`);
        return;
    }
    if (marketOpts.endDateIso) {
        // Gamma API returns endDate as Unix timestamp (seconds), not ISO string.
        // new Date("1749696000") interprets as ms → date in 1970.
        let endMs;
        if (/^\d{10}$/.test(String(marketOpts.endDateIso))) {
            endMs = Number(marketOpts.endDateIso) * 1000;  // seconds → ms
        } else {
            endMs = new Date(marketOpts.endDateIso).getTime();
        }
        const secsLeft = (endMs - Date.now()) / 1000;
        if (secsLeft < config.minMarketTimeLeft) {
            const minsLeft = Math.max(0, Math.floor(secsLeft / 60));
            const sLeft    = Math.max(0, Math.floor(secsLeft % 60));
            logger.warn(
                `Market expires in ${minsLeft}m ${sLeft}s — below MIN_MARKET_TIME_LEFT ` +
                `(${config.minMarketTimeLeft}s). Skipping buy: ${market || effectiveConditionId}`,
            );
            return;
        }
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

    // Calculate our trade size (independent of individual fill event)
    let tradeSize = await calculateTradeSize();

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

    // Check balance
    const balance = await getClobBalance();
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

    // Place market order (FAK) with retries
    const client = getClient();
    let filled = false;
    let totalSharesFilled = 0;
    let totalCostFilled = 0;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        try {
            const remainingAmount = tradeSize - totalCostFilled;
            if (remainingAmount < effectiveMin) {
                if (remainingAmount > 0) logger.info(`Remaining $${remainingAmount.toFixed(2)} below $${effectiveMin} minimum — stopping`);
                break;
            }

            logger.info(`Buy attempt ${attempt}/${config.maxRetries} | Amount: $${remainingAmount.toFixed(2)}`);

            const response = await client.createAndPostMarketOrder(
                {
                    tokenID: tokenId,
                    side: Side.BUY,
                    amount: remainingAmount,
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
                const costFilled   = parseFloat(response.makingAmount || '0');

                if (sharesFilled > 0) {
                    logger.success(`Order filled: ${response.orderID} | ${sharesFilled.toFixed(4)} shares @ ~$${(costFilled / sharesFilled).toFixed(4)}`);
                    totalSharesFilled += sharesFilled;
                    totalCostFilled   += costFilled || (sharesFilled * price);
                    filled = true;
                    // If remainder is below $1 minimum, stop; otherwise loop for partial fill
                    if (tradeSize - totalCostFilled < effectiveMin) break;
                } else {
                    logger.warn(`No liquidity — FAK filled 0 shares (attempt ${attempt})`);
                }
            } else {
                logger.warn(`Order rejected: ${response?.errorMsg || 'unknown'}`);
            }
        } catch (err) {
            logger.error(`Buy attempt ${attempt} failed: ${err.message}`);
        }

        if (attempt < config.maxRetries) {
            await new Promise((r) => setTimeout(r, config.retryDelay));
        }
    }

    // FAK found no liquidity — fall back to GTC limit order and wait for fill
    if (!filled && config.gtcFallbackTimeout > 0) {
        const gtcResult = await _tryGtcFallback(client, tokenId, tradeSize, price, marketOpts);
        if (gtcResult) {
            totalSharesFilled = gtcResult.sharesFilled;
            totalCostFilled   = gtcResult.costFilled;
            filled = true;
        }
    }

    if (!filled || totalCostFilled === 0) {
        logger.error(`Failed to fill buy order for ${market || tokenId} after ${config.maxRetries} attempts`);
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
            } catch { /* ignore */ }
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

    let filled = false;

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
                        filled = true;
                        break;
                    } else {
                        logger.warn(`No bid liquidity — FAK filled 0 shares (attempt ${attempt})`);
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
                    filled = true;
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

    if (filled) {
        removePosition(effectiveConditionId);
        logger.money(`Position sold: ${position.market}`);
    } else {
        updatePosition(effectiveConditionId, { status: 'open' });
        logger.error(`Failed to sell ${position.market} after ${config.maxRetries} attempts`);
    }
}
