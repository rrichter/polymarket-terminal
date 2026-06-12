import WebSocket from 'ws';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { readState, writeState } from '../utils/state.js';

const RTDS_WS_URL = 'wss://ws-live-data.polymarket.com';
const PING_INTERVAL_MS = 5000;
const INITIAL_RECONNECT_DELAY = 2000;
const MAX_RECONNECT_DELAY = 30000;
const PROCESSED_FILE = 'processed_trades.json';
const MAX_PROCESSED_IDS = 10_000;    // in-memory cap, pruned periodically
const FLUSH_INTERVAL_MS = 30_000;    // flush to disk every 30s

// Set DEBUG_RTDS=true in .env to log raw RTDS activity payloads (for diagnosing missed trades)
const DEBUG_RTDS = process.env.DEBUG_RTDS === 'true';

let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let reconnectDelay = INITIAL_RECONNECT_DELAY;
let tradeHandler = null;
let isShuttingDown = false;
let _flushTimer = null;

// Track stats for diagnosing missed trades
let _msgCount = 0;
let _activityCount = 0;
let _filteredCount = 0;
let _matchedCount = 0;

// ── In-memory dedup Set — avoids synchronous disk I/O on every trade event ──
// Initialized on connect(), loaded from processed_trades.json for crash recovery.
const _processedIds = new Set();
let _dirty = false; // true if there are unflushed additions

/** Load processed IDs from disk (one-time at startup). */
function _loadProcessedFromDisk() {
    try {
        const data = readState(PROCESSED_FILE, { tradeIds: [] });
        if (Array.isArray(data.tradeIds)) {
            for (const id of data.tradeIds) {
                _processedIds.add(id);
            }
        }
        logger.info(`Loaded ${_processedIds.size} processed trade IDs from disk`);
    } catch (err) {
        logger.warn(`Could not load processed trades: ${err.message}`);
    }
}

/** Flush the in-memory Set to disk. Called periodically and on shutdown. */
function _flushToDisk() {
    if (!_dirty) return;
    try {
        // Keep only the most recent MAX_PROCESSED_IDS entries
        const ids = Array.from(_processedIds);
        if (ids.length > MAX_PROCESSED_IDS) {
            const trimmed = ids.slice(-MAX_PROCESSED_IDS);
            _processedIds.clear();
            for (const id of trimmed) _processedIds.add(id);
        }
        writeState(PROCESSED_FILE, { tradeIds: Array.from(_processedIds) });
        _dirty = false;
    } catch (err) {
        logger.warn(`Could not flush processed trades: ${err.message}`);
    }
}

/** Start periodic disk flush. */
function _startFlushTimer() {
    _stopFlushTimer();
    _flushTimer = setInterval(_flushToDisk, FLUSH_INTERVAL_MS);
}

/** Stop periodic disk flush. */
function _stopFlushTimer() {
    if (_flushTimer) {
        clearInterval(_flushTimer);
        _flushTimer = null;
    }
}

/** Check-and-insert a trade ID. Returns true if new (not previously seen). */
function markProcessed(tradeId) {
    if (_processedIds.has(tradeId)) return false;
    _processedIds.add(tradeId);
    _dirty = true;
    // Prune in-memory if over 2x the cap (rare)
    if (_processedIds.size > MAX_PROCESSED_IDS * 2) {
        const ids = Array.from(_processedIds).slice(-MAX_PROCESSED_IDS);
        _processedIds.clear();
        for (const id of ids) _processedIds.add(id);
    }
    return true;
}

/** Pure check — returns true if trade ID was already processed (no side effect). */
function hasProcessed(tradeId) {
    return _processedIds.has(tradeId);
}

function handleMessage(rawData) {
    let msg;
    try {
        msg = JSON.parse(rawData.toString());
    } catch (_) {
        const text = rawData.toString().trim();
        if (text === 'ping') {
            ws?.send('pong');
        }
        return;
    }

    _msgCount++;

    // Handle ping/heartbeat
    if (msg.type === 'ping' || msg === 'ping') {
        ws?.send('pong');
        return;
    }

    // Only process activity trade events
    if (msg.topic !== 'activity') return;

    _activityCount++;
    const payload = msg.payload;
    if (!payload) return;

    // ── DEBUG: log raw payload to diagnose missed trades ───────────────
    if (DEBUG_RTDS && _activityCount <= 50) {
        // Log first 50 activity events with their field names
        const keys = Object.keys(payload).join(', ');
        const side = payload.side || payload.type || payload.direction || '?';
        const wallet = payload.proxyWallet || payload.proxy_wallet || payload.user || payload.owner || payload.maker || '?';
        logger.info(`RTDS DEBUG #${_activityCount}: side="${side}" wallet="${typeof wallet === 'string' ? wallet.slice(0, 12) : '?'}…" asset="${(payload.asset || '?').slice(0, 16)}…" fields=[${keys}]`);
    }

    // Filter by target trader's address (case-insensitive)
    // Try multiple common field names — Polymarket RTDS may use any of these
    const traderAddr = config.traderAddress.toLowerCase();
    const walletField = payload.proxyWallet || payload.proxy_wallet ||
                        payload.user || payload.owner || payload.maker || '';
    const proxyWallet = (typeof walletField === 'string' ? walletField : '').toLowerCase();

    if (!proxyWallet || proxyWallet !== traderAddr) {
        _filteredCount++;
        return;
    }

    _matchedCount++;

    // Build trade ID
    const tradeId = payload.transactionHash || payload.transaction_hash ||
        `${payload.timestamp}_${payload.asset}`;

    // Deduplication
    if (!markProcessed(tradeId)) {
        logger.watch(`Duplicate trade skipped: ${tradeId}`);
        return;
    }

    // Parse trade type
    const type = (payload.side || '').toUpperCase();
    if (!['BUY', 'SELL'].includes(type)) {
        logger.warn(`Unknown trade side: ${payload.side}`);
        return;
    }

    const tokenId = payload.asset || '';
    if (!tokenId) {
        logger.warn(`Trade missing asset/tokenId: ${tradeId}`);
        return;
    }

    const trade = {
        id: tradeId,
        type,
        tokenId,
        conditionId: payload.conditionId || payload.condition_id || '',
        market: payload.title || payload.name || '',
        price: parseFloat(payload.price || '0'),
        size: parseFloat(payload.size || '0'),
        side: type,
        timestamp: payload.timestamp || new Date().toISOString(),
        outcome: payload.outcome || '',
        proxyWalletAddress: payload.proxyWallet || '',
    };

    logger.watch(`Trade detected! ${type} - ${trade.market || trade.tokenId}`);
    logger.watch(`  Size: ${trade.size} shares @ $${trade.price}`);

    if (tradeHandler) {
        tradeHandler(trade).catch((err) => {
            logger.error(`Error handling trade: ${err.message}`);
        });
    }
}

function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send('ping');
        }
    }, PING_INTERVAL_MS);
}

function stopPing() {
    if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
    }
}

function cleanup(reconnect = true) {
    stopPing();
    _stopFlushTimer();
    _flushToDisk(); // persist on disconnect
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ws) {
        ws.removeAllListeners();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.terminate();
        }
        ws = null;
    }
    if (reconnect && !isShuttingDown) {
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    logger.info(`Reconnecting in ${reconnectDelay / 1000}s...`);
    reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        connect();
    }, reconnectDelay);
}

function connect() {
    if (isShuttingDown) return;

    // Load processed IDs from disk (crash recovery) on first connect
    if (_processedIds.size === 0) {
        _loadProcessedFromDisk();
    }
    _startFlushTimer();

    logger.info('Connecting to Polymarket RTDS WebSocket...');
    ws = new WebSocket(RTDS_WS_URL);

    ws.on('open', () => {
        logger.success('WebSocket connected! Subscribing to activity feed...');
        logger.watch(`Watching trader: ${config.traderAddress}`);
        reconnectDelay = INITIAL_RECONNECT_DELAY;

        ws.send(JSON.stringify({
            action: 'subscribe',
            subscriptions: [{
                topic: 'activity',
                type: 'trades',
            }],
        }));

        startPing();

        // Log WebSocket stats every 5 minutes for health monitoring
        const statsInterval = setInterval(() => {
            if (isShuttingDown) { clearInterval(statsInterval); return; }
            if (_activityCount > 0) {
                logger.info(`WS stats: ${_msgCount} msgs, ${_activityCount} activities, ${_matchedCount} matched, ${_filteredCount} filtered (non-trader)`);
            }
        }, 300_000);
    });

    ws.on('message', (data) => {
        handleMessage(data);
    });

    ws.on('ping', () => {
        ws?.pong();
    });

    ws.on('close', (code, reason) => {
        const reasonStr = reason ? reason.toString() : 'no reason';
        logger.warn(`WebSocket closed (${code}): ${reasonStr}`);
        cleanup(true);
    });

    ws.on('error', (err) => {
        logger.error(`WebSocket error: ${err.message}`);
        cleanup(true);
    });
}

/**
 * Start the real-time WebSocket watcher
 * @param {Function} onTrade - async function called when trader makes a trade
 */
export function startWsWatcher(onTrade) {
    tradeHandler = onTrade;
    isShuttingDown = false;
    reconnectDelay = INITIAL_RECONNECT_DELAY;
    connect();
}

/**
 * Stop the WebSocket watcher
 */
export function stopWsWatcher() {
    isShuttingDown = true;
    cleanup(false);
    logger.info('WebSocket watcher stopped');
}

/**
 * Exported for use by the polling safety net.
 * Checks whether a trade ID has already been processed (in-memory dedup).
 * Returns true if NEW (not previously seen), false if duplicate.
 */
export { markProcessed, hasProcessed };
