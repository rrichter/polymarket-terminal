/**
 * sniperExecutor.js
 * 3-Tier Sniper Strategy:
 *   - Tier 1: 3c price, smallest size (20% of max)
 *   - Tier 2: 2c price, medium size (30% of max)
 *   - Tier 3: 1c price, largest size (50% of max)
 *   Min 5 shares per tier, total = SNIPER_MAX_SHARES × timeMultiplier
 */

import { Side, OrderType } from '@polymarket/clob-client-v2';
import config from '../config/index.js';
import { getClient } from './client.js';
import logger from '../utils/logger.js';
import { getTimeMultiplier } from './sniperSizing.js';

// In-memory tracking of placed snipe orders
const activeSnipes = [];

// conditionId → { asset, yesTokenId, noTokenId } mapping
// yesTokenId = outcome 0 (clobTokenIds[0]), noTokenId = outcome 1 (clobTokenIds[1])
const conditionInfoMap = new Map();

export function getActiveSnipes() {
    return [...activeSnipes];
}

export function getConditionAsset(conditionId) {
    return conditionInfoMap.get(conditionId)?.asset || null;
}

export function getConditionInfo(conditionId) {
    return conditionInfoMap.get(conditionId) || null;
}

/**
 * Calculate tier sizes based on max shares.
 * Distribution: 20% | 30% | 50% (high→low price)
 * Minimum 5 shares per tier.
 */
function calculateTierSizes(maxShares, minPerTier) {
    // Distribution percentages
    const ratios = [0.20, 0.30, 0.50]; // Tier 1, 2, 3

    const sizes = ratios.map(ratio => {
        const size = Math.floor(maxShares * ratio);
        return Math.max(size, minPerTier);
    });

    // Ensure we don't exceed maxShares after rounding up to minimums
    const total = sizes.reduce((a, b) => a + b, 0);
    if (total > maxShares) {
        // Adjust tier 3 (largest) down if needed
        sizes[2] = Math.max(minPerTier, sizes[2] - (total - maxShares));
    }

    return sizes;
}

export async function executeSnipe(market) {
    const { asset, conditionId, question, yesTokenId, noTokenId, tickSize, negRisk } = market;
    const label = question.slice(0, 40);
    const sim   = config.dryRun ? '[SIM] ' : '';

    // Track conditionId → { asset, token IDs } for win detection
    // yesTokenId = outcome 0 (clobTokenIds[0]), noTokenId = outcome 1 (clobTokenIds[1])
    conditionInfoMap.set(conditionId, {
        asset: asset.toLowerCase(),
        yesTokenId,
        noTokenId,
    });

    const sides = [
        { name: 'UP',   tokenId: yesTokenId },
        { name: 'DOWN', tokenId: noTokenId  },
    ];

    // Apply time-based multiplier
    const { multiplier, label: mulLabel } = getTimeMultiplier();
    const effectiveMaxShares = Math.max(
        config.sniperMinSharesPerTier * 3,
        Math.round(config.sniperMaxShares * multiplier),
    );

    const prices = config.sniperTierPrices;
    const sizes = calculateTierSizes(effectiveMaxShares, config.sniperMinSharesPerTier);

    const mulInfo = multiplier !== 1.0 ? ` | mul ${mulLabel}` : '';
    logger.info(`SNIPER: ${sim}${asset.toUpperCase()} — "${label}" | 3-tier: 3c×${sizes[0]} | 2c×${sizes[1]} | 1c×${sizes[2]}${mulInfo}`);

    for (const { name, tokenId } of sides) {
        // Place 3 orders per side
        for (let tier = 0; tier < 3; tier++) {
            const price = prices[tier];
            const size = sizes[tier];

            if (config.dryRun) {
                const cost = price * size;
                logger.trade(`SNIPER[SIM]: ${asset.toUpperCase()} ${name} T${tier+1} @ $${price.toFixed(2)} × ${size}sh | cost $${cost.toFixed(3)}`);
                activeSnipes.push({
                    asset: asset.toUpperCase(),
                    side: name,
                    tier: tier + 1,
                    question: label,
                    orderId: `sim-${Date.now()}-${tier}-${tokenId.slice(-6)}`,
                    price,
                    shares: size,
                    cost,
                    potentialPayout: size,
                });
                continue;
            }

            const client = getClient();
            try {
                const res = await client.createAndPostOrder(
                    {
                        tokenID: tokenId,
                        side:    Side.BUY,
                        price:   price,
                        size:    size,
                    },
                    { tickSize, negRisk },
                    OrderType.GTC,
                );

                if (res?.success) {
                    const cost = price * size;
                    logger.trade(`SNIPER: ${asset.toUpperCase()} ${name} T${tier+1} @ $${price.toFixed(2)} × ${size}sh | cost $${cost.toFixed(3)} | order ${res.orderID}`);
                    activeSnipes.push({
                        asset: asset.toUpperCase(),
                        side: name,
                        tier: tier + 1,
                        question: label,
                        orderId: res.orderID,
                        price,
                        shares: size,
                        cost,
                        potentialPayout: size,
                    });
                } else {
                    logger.warn(`SNIPER: ${asset.toUpperCase()} ${name} T${tier+1} failed — ${res?.errorMsg || 'unknown'}`);
                }
            } catch (err) {
                logger.error(`SNIPER: ${asset.toUpperCase()} ${name} T${tier+1} error — ${err.message}`);
            }
        }
    }
}
