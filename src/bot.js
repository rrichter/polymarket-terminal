/**
 * bot.js — PM2 / VPS entry point (no TUI)
 *
 * Plain-text stdout output, compatible with:
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs polymarket-copy
 */
import config, { validateConfig } from './config/index.js';
import { initClient, getClient, getClobBalance } from './services/client.js';
import { executeBuy, executeSell, getOnChainTokenBalance } from './services/executor.js';
import { checkAndRedeemPositions } from './services/redeemer.js';
import { getOpenPositions, updatePosition, removePosition } from './services/position.js';
import { startWsWatcher, stopWsWatcher } from './services/wsWatcher.js';
import { copyFillWatcher } from './services/copyFillWatcher.js';
import { getSimStats } from './utils/simStats.js';
import logger from './utils/logger.js';

logger.interceptConsole(); // strip auth headers from CLOB axios error dumps

// ── Handle a trade event from WebSocket ───────────────────────────────────────
async function handleTrade(trade) {
    try {
        if (trade.type === 'BUY')  await executeBuy(trade);
        if (trade.type === 'SELL') await executeSell(trade);
    } catch (err) {
        logger.error(`Error processing trade ${trade.id}: ${err.message}`);
    }
}

// ── Parse weather market title ────────────────────────────────────────────────
function parseWeatherTitle(rawName) {
    const match = rawName.match(/^Will the highest temperature in (.+?) be between (.+?) on (.+?)\??$/);
    return match ? { city: match[1], tempRange: match[2], date: match[3] } : null;
}

function dateSortKey(dateStr) {
    const months = { january:1,february:2,march:3,april:4,may:5,june:6,
                     july:7,august:8,september:9,october:10,november:11,december:12 };
    const m = dateStr.match(/^([A-Za-z]+)\s+(\d+)$/);
    return m ? (months[m[1].toLowerCase()] || 0) * 100 + parseInt(m[2], 10) : 0;
}

function tempSortKey(tempStr) {
    const m = tempStr.match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
}

// ── Periodic status log (replaces TUI right panel) ────────────────────────────
async function printStatus() {
    try {
        const balance   = await getClobBalance();
        const positions = getOpenPositions();

        // ── Reconcile positions against on-chain balances ─────────────────
        // Catches partial fills, manual sells, and any drift that the WS
        // fill watcher might have missed (e.g., during reconnects).
        for (const pos of positions) {
            try {
                const onChain = await getOnChainTokenBalance(pos.tokenId);
                if (onChain !== null) {
                    if (onChain < 0.0001) {
                        logger.info(`On-chain balance is 0 — removing position: ${pos.market}`);
                        removePosition(pos.conditionId);
                    } else if (Math.abs(onChain - pos.shares) > 0.001) {
                        logger.info(`Reconciling shares for ${pos.market}: stored ${pos.shares.toFixed(4)} → on-chain ${onChain.toFixed(4)}`);
                        const ratio = onChain / pos.shares;
                        updatePosition(pos.conditionId, {
                            shares: onChain,
                            totalCost: (pos.totalCost || 0) * ratio,
                        });
                    }
                }
            } catch { /* skip individual reconciliation errors */ }
        }

        // Refetch after reconciliation (some positions may have been removed)
        const current = getOpenPositions();

        logger.info(`--- Status | Balance: $${balance.toFixed(2)} USDC | Open positions: ${current.length} ---`);

        // Parse & sort: city → date → temperature
        const sorted = current.map(pos => {
            const parsed = parseWeatherTitle(pos.market || '');
            return { pos, parsed };
        }).sort((a, b) => {
            if (!a.parsed && !b.parsed) return 0;
            if (!a.parsed) return 1;
            if (!b.parsed) return -1;
            const cityCmp = a.parsed.city.localeCompare(b.parsed.city);
            if (cityCmp !== 0) return cityCmp;
            const dateCmp = dateSortKey(a.parsed.date) - dateSortKey(b.parsed.date);
            if (dateCmp !== 0) return dateCmp;
            return tempSortKey(a.parsed.tempRange) - tempSortKey(b.parsed.tempRange);
        });

        for (const { pos } of sorted) {
            let pnlStr = '';
            try {
                const client = getClient();
                const mp = await client.getMidpoint(pos.tokenId);
                const mid = parseFloat(mp?.mid ?? mp ?? '0');
                if (mid > 0) {
                    const pnl  = (mid - pos.avgBuyPrice) * pos.shares;
                    const sign = pnl >= 0 ? '+' : '';
                    const pct  = pos.totalCost > 0 ? ((pnl / pos.totalCost) * 100).toFixed(1) : '0.0';
                    pnlStr = ` | unrealized ${sign}$${pnl.toFixed(2)} (${sign}${pct}%)`;
                }
            } catch { /* price unavailable */ }

            const parsed = parseWeatherTitle(pos.market || '');
            const name = parsed
                ? `${parsed.city} | ${parsed.date} | ${parsed.tempRange}`
                : (pos.market || pos.tokenId || '');
            logger.info(
                `  [${pos.outcome || '?'}] ${name}` +
                ` | ${pos.shares.toFixed(4)} sh @ $${pos.avgBuyPrice.toFixed(4)}` +
                ` | spent $${(pos.totalCost || 0).toFixed(2)}${pnlStr}`,
            );
        }

        if (config.dryRun) {
            const s = getSimStats();
            if (s.totalBuys > 0 || s.totalResolved > 0) {
                const rate = s.totalResolved > 0
                    ? `${((s.wins / s.totalResolved) * 100).toFixed(0)}% win`
                    : 'no resolved yet';
                logger.info(
                    `  [SIM] ${s.totalBuys} buys tracked | ${s.wins}W/${s.losses}L (${rate})` +
                    ` | realized P&L: $${(s.closedPnl || 0).toFixed(2)}`,
                );
            }
        }
    } catch (err) {
        logger.warn(`Status check error: ${err.message}`);
    }
}

// ── Redeemer loop ─────────────────────────────────────────────────────────────
async function redeemerLoop() {
    try {
        await checkAndRedeemPositions();
    } catch (err) {
        logger.error('Redeemer loop error:', err.message);
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    try {
        validateConfig();
    } catch (err) {
        logger.error(err.message);
        process.exit(1);
    }

    const mode = config.dryRun ? 'SIMULATION' : 'LIVE TRADING';
    logger.info(`=== Polymarket Copy Trade [${mode}] ===`);
    logger.info(`Trader       : ${config.traderAddress}`);
    logger.info(`Proxy wallet : ${config.proxyWallet}`);
    logger.info(`Size mode    : ${config.sizeMode} (${config.sizePercent}%)`);
    logger.info(`Min trade    : $${config.minTradeSize}`);
    logger.info(`Max position : $${config.maxPositionSize} per market`);
    logger.info(`Auto sell    : ${config.autoSellEnabled ? `ON (+${config.autoSellProfitPercent}%)` : 'OFF'}`);
    logger.info(`Sell mode    : ${config.sellMode}`);
    logger.info('==========================================');

    try {
        await initClient();
    } catch (err) {
        logger.error('Failed to initialize CLOB client:', err.message);
        process.exit(1);
    }

    // Get balance from CLOB REST API (authenticated — always accurate)
    try {
        const balance = await getClobBalance();
        logger.money(`USDC.e Balance: $${balance.toFixed(2)}`);
    } catch (err) {
        logger.warn('Could not fetch balance:', err.message);
    }

    logger.success(
        config.dryRun
            ? 'Simulation started — watching trader in real-time...'
            : 'Bot started — watching trader in real-time...',
    );

    startWsWatcher(handleTrade);

    // ── Own-fill watcher: detect when our sell orders execute ─────────────
    // Keeps positions.json in sync for partial fills and auto-sell GTC fills
    // that happen asynchronously (not triggered by a trader's sell signal).
    copyFillWatcher.start();
    copyFillWatcher.on('sellFilled', ({ tokenId, conditionId, shares, price }) => {
        // Try to find the position by conditionId
        const positions = getOpenPositions();
        const pos = positions.find(p => p.conditionId === conditionId);
        if (!pos) {
            // Fallback: search by tokenId
            const byToken = positions.find(p => p.tokenId === tokenId);
            if (!byToken) return;
            const remaining = byToken.shares - shares;
            if (remaining < 0.0001) {
                logger.money(`Position fully sold (own-fill): ${byToken.market} | ${shares} sh @ $${price.toFixed(4)}`);
                removePosition(byToken.conditionId);
            } else {
                const remainingCost = remaining * byToken.avgBuyPrice;
                updatePosition(byToken.conditionId, { shares: remaining, totalCost: remainingCost, status: 'open' });
                logger.money(`Partial sell (own-fill): ${byToken.market} | ${shares} sh filled, ${remaining.toFixed(4)} remaining`);
            }
            return;
        }
        const remaining = pos.shares - shares;
        if (remaining < 0.0001) {
            logger.money(`Position fully sold (own-fill): ${pos.market} | ${shares} sh @ $${price.toFixed(4)}`);
            removePosition(conditionId);
        } else {
            const remainingCost = remaining * pos.avgBuyPrice;
            updatePosition(conditionId, { shares: remaining, totalCost: remainingCost, status: 'open' });
            logger.money(`Partial sell (own-fill): ${pos.market} | ${shares} sh filled, ${remaining.toFixed(4)} remaining`);
        }
    });

    await redeemerLoop();
    const redeemerInterval = setInterval(redeemerLoop, config.redeemInterval);

    // Print status every 60 seconds
    const statusInterval = setInterval(printStatus, 60_000);

    const shutdown = () => {
        logger.info('Shutting down...');
        stopWsWatcher();
        copyFillWatcher.stop();
        clearInterval(redeemerInterval);
        clearInterval(statusInterval);
        setTimeout(() => process.exit(0), 300);
    };

    process.on('SIGINT',  shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    logger.error('Fatal error:', err.message);
    process.exit(1);
});
