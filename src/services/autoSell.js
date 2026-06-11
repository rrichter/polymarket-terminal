import { Side, OrderType } from '@polymarket/clob-client-v2';
import config from '../config/index.js';
import { getClient } from './client.js';
import { updatePosition } from './position.js';
import logger from '../utils/logger.js';

/**
 * Place an auto-sell limit order at profit target above avg buy price
 * @param {string} conditionId - Market condition ID
 * @param {string} tokenId - CLOB token ID
 * @param {number} shares - Number of shares to sell
 * @param {number} avgBuyPrice - Average buy price
 * @param {Object} marketOpts - { tickSize, negRisk }
 */
export async function placeAutoSell(conditionId, tokenId, shares, avgBuyPrice, marketOpts) {
    try {
        const profitMultiplier = 1 + config.autoSellProfitPercent / 100;
        let sellPrice = avgBuyPrice * profitMultiplier;

        // Round to tick size
        const tickSize = parseFloat(marketOpts.tickSize);
        sellPrice = Math.round(sellPrice / tickSize) * tickSize;

        // Clamp between 0.01 and 0.99
        sellPrice = Math.max(0.01, Math.min(0.99, sellPrice));

        // Format to proper decimal places
        const decimals = marketOpts.tickSize.split('.')[1]?.length || 2;
        sellPrice = parseFloat(sellPrice.toFixed(decimals));

        logger.trade(`Auto-sell: ${shares} shares @ $${sellPrice} (${config.autoSellProfitPercent}% above avg buy $${avgBuyPrice.toFixed(4)})`);

        if (config.dryRun) {
            logger.info('[DRY RUN] Would place limit sell order');
            updatePosition(conditionId, { sellOrderId: 'dry-run-order' });
            return;
        }

        const client = getClient();
        const response = await client.createAndPostOrder(
            {
                tokenID: tokenId,
                price: sellPrice,
                size: shares,
                side: Side.SELL,
            },
            {
                tickSize: marketOpts.tickSize,
                negRisk: marketOpts.negRisk,
            },
            OrderType.GTC,
        );

        if (response && response.success) {
            logger.success(`Auto-sell order placed: ${response.orderID} @ $${sellPrice}`);
            updatePosition(conditionId, { sellOrderId: response.orderID });
        } else {
            logger.warn(`Auto-sell failed: ${response?.errorMsg || 'Unknown'}`);
        }
    } catch (err) {
        logger.error('Failed to place auto-sell:', err.message);
    }
}
