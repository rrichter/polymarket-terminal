/**
 * copyFillWatcher.js
 * Real-time own-fill detection for the Copy Trade bot via Polymarket RTDS WebSocket.
 *
 * Watches the bot's own proxy wallet on the activity feed. When our BUY or SELL
 * orders fill, emits events so the executor can react immediately — no need to
 * wait for REST API confirmation or poll order status.
 *
 * Primary use case: detecting auto-sell (GTC limit) fills that happen minutes/hours
 * after placement, and detecting GTC fallback fills from the parallel buy strategy.
 *
 * Usage:
 *   import { copyFillWatcher } from './copyFillWatcher.js';
 *   copyFillWatcher.on('sellFilled', ({ tokenId, conditionId, shares, price }) => {
 *       // Update position, log P&L, etc.
 *   });
 *   copyFillWatcher.start();
 *   copyFillWatcher.stop();
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import config from '../config/index.js';
import logger from '../utils/logger.js';

const RTDS_WS_URL = 'wss://ws-live-data.polymarket.com';
const PING_INTERVAL_MS = 5000;
const INITIAL_RECONNECT_DELAY = 15000;
const MAX_RECONNECT_DELAY = 120000;

class CopyFillWatcher extends EventEmitter {
    constructor() {
        super();
        this._ws = null;
        this._pingTimer = null;
        this._reconnectTimer = null;
        this._reconnectDelay = INITIAL_RECONNECT_DELAY;
        this._shuttingDown = false;
        this._connected = false;
    }

    get connected() {
        return this._connected;
    }

    /** Start the WebSocket connection */
    start() {
        this._shuttingDown = false;
        this._reconnectDelay = INITIAL_RECONNECT_DELAY;
        this._connect();
    }

    /** Gracefully stop */
    stop() {
        this._shuttingDown = true;
        this._cleanup(false);
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    _connect() {
        if (this._shuttingDown) return;

        logger.info('Copy fill watcher: connecting to RTDS WebSocket...');
        this._ws = new WebSocket(RTDS_WS_URL);

        this._ws.on('open', () => {
            this._connected = true;
            this._reconnectDelay = INITIAL_RECONNECT_DELAY;
            logger.success('Copy fill watcher: connected — watching own fills');

            this._ws.send(JSON.stringify({
                action: 'subscribe',
                subscriptions: [{ topic: 'activity', type: 'trades' }],
            }));

            this._startPing();
        });

        this._ws.on('message', (data) => this._handleMessage(data));
        this._ws.on('ping', () => this._ws?.pong());

        this._ws.on('close', (code, reason) => {
            this._connected = false;
            logger.warn(`Copy fill watcher: WS closed (${code}): ${reason || 'no reason'}`);
            this._cleanup(true);
        });

        this._ws.on('error', (err) => {
            this._connected = false;
            if (err.message.includes('429')) {
                this._reconnectDelay = Math.max(this._reconnectDelay, 60000);
                logger.warn(`Copy fill watcher: rate-limited (429) — backing off ${this._reconnectDelay / 1000}s`);
            } else {
                logger.error(`Copy fill watcher: WS error: ${err.message}`);
            }
            this._cleanup(true);
        });
    }

    _handleMessage(rawData) {
        let msg;
        try {
            msg = JSON.parse(rawData.toString());
        } catch (_) {
            const text = rawData.toString().trim();
            if (text === 'ping') this._ws?.send('pong');
            return;
        }

        if (msg.type === 'ping' || msg === 'ping') {
            this._ws?.send('pong');
            return;
        }

        if (msg.topic !== 'activity') return;

        const payload = msg.payload;
        if (!payload) return;

        // Filter: only our own proxy wallet
        const ourWallet = config.proxyWallet?.toLowerCase();
        if (!ourWallet) return;

        const proxyWallet = (payload.proxyWallet || payload.proxy_wallet || '').toLowerCase();
        if (proxyWallet !== ourWallet) return;

        const tokenId = payload.asset || '';
        const conditionId = payload.conditionId || payload.condition_id || '';
        const side = (payload.side || '').toUpperCase();
        const size = parseFloat(payload.size || '0');
        const price = parseFloat(payload.price || '0');

        if (size <= 0 || !['BUY', 'SELL'].includes(side)) return;

        if (side === 'BUY') {
            this.emit('buyFilled', { tokenId, conditionId, shares: size, price });
        } else {
            this.emit('sellFilled', { tokenId, conditionId, shares: size, price });
        }
    }

    _startPing() {
        this._stopPing();
        this._pingTimer = setInterval(() => {
            if (this._ws?.readyState === WebSocket.OPEN) {
                this._ws.send('ping');
            }
        }, PING_INTERVAL_MS);
    }

    _stopPing() {
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
    }

    _cleanup(reconnect = true) {
        this._stopPing();
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._ws) {
            this._ws.removeAllListeners();
            if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
                this._ws.terminate();
            }
            this._ws = null;
        }
        this._connected = false;
        if (reconnect && !this._shuttingDown) {
            this._scheduleReconnect();
        }
    }

    _scheduleReconnect() {
        logger.info(`Copy fill watcher: reconnecting in ${this._reconnectDelay / 1000}s...`);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectDelay = Math.min(this._reconnectDelay * 2, MAX_RECONNECT_DELAY);
            this._connect();
        }, this._reconnectDelay);
    }
}

/** Singleton instance */
export const copyFillWatcher = new CopyFillWatcher();
