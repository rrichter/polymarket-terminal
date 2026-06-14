/**
 * cache.js
 * Generic TTL (Time-To-Live) in-memory cache.
 *
 * Usage:
 *   const cache = new TTLCache({ ttlMs: 60_000, maxSize: 200 });
 *   const value = await cache.get(key, async () => await fetchData(key));
 */

export class TTLCache {
    /**
     * @param {Object} opts
     * @param {number} opts.ttlMs        - Entry lifetime in milliseconds (default 60s)
     * @param {number} [opts.maxSize]    - Max entries before pruning oldest (default 500)
     */
    constructor(opts = {}) {
        this._ttlMs = opts.ttlMs ?? 60_000;
        this._maxSize = opts.maxSize ?? 500;
        this._map = new Map(); // key → { value, expiresAt }
    }

    /**
     * Get a cached value, or compute and store it if missing/expired.
     *
     * @param {string} key
     * @param {() => Promise<any>} factory - async function to compute the value
     * @returns {Promise<any>}
     */
    async get(key, factory) {
        const entry = this._map.get(key);
        if (entry && entry.expiresAt > Date.now()) {
            return entry.value;
        }
        // Compute fresh value
        const value = await factory();
        this.set(key, value);
        return value;
    }

    /**
     * Synchronous peek — returns the cached value without calling the factory.
     * Returns undefined if the key is missing or expired.
     *
     * @param {string} key
     * @returns {any|undefined}
     */
    peek(key) {
        const entry = this._map.get(key);
        if (entry && entry.expiresAt > Date.now()) {
            return entry.value;
        }
        return undefined;
    }

    /**
     * Store a value in the cache.
     */
    set(key, value) {
        // Prune if at capacity
        if (this._map.size >= this._maxSize) {
            const oldest = this._map.keys().next().value;
            this._map.delete(oldest);
        }
        this._map.set(key, {
            value,
            expiresAt: Date.now() + this._ttlMs,
        });
    }

    /**
     * Remove an entry.
     */
    delete(key) {
        this._map.delete(key);
    }

    /**
     * Clear all entries.
     */
    clear() {
        this._map.clear();
    }

    /**
     * Number of cached entries.
     */
    get size() {
        return this._map.size;
    }
}
