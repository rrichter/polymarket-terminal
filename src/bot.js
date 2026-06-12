/**
 * bot.js — PM2 / VPS entry point (no TUI)
 *
 * Plain-text stdout output, compatible with:
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs polymarket-copy
 */
import config, { validateConfig } from './config/index.js';
import { initClient, getClient, getClobBalance } from './services/client.js';
import { executeBuy, executeSell } from './services/executor.js';
import { checkAndRedeemPositions } from './services/redeemer.js';
import { getOpenPositions } from './services/position.js';
import { startWsWatcher, stopWsWatcher } from './services/wsWatcher.js';
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

// ── Periodic status log (replaces TUI right panel) ────────────────────────────
async function printStatus() {
    try {
        const balance   = await getClobBalance();
        const positions = getOpenPositions();

        logger.info(`--- Status | Balance: $${balance.toFixed(2)} USDC | Open positions: ${positions.length} ---`);

        for (const pos of positions) {
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

            const name = (pos.market || pos.tokenId || '').substring(0, 50);
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

    await redeemerLoop();
    const redeemerInterval = setInterval(redeemerLoop, config.redeemInterval);

    // Print status every 60 seconds
    const statusInterval = setInterval(printStatus, 60_000);

    const shutdown = () => {
        logger.info('Shutting down...');
        stopWsWatcher();
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
