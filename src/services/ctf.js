/**
 * ctf.js
 * Helpers for interacting with Polymarket's ConditionalTokens (CTF) contract
 * directly from the Gnosis Safe proxy wallet.
 *
 * Key operations:
 *   splitPosition   — deposit USDC → receive equal YES+NO tokens at $0.50 each
 *   mergePositions  — return equal YES+NO tokens → recover USDC (cut-loss with no slippage)
 */

import { ethers } from 'ethers';
import config from '../config/index.js';
import { getSigner, getPolygonProvider } from './client.js';
import logger from '../utils/logger.js';
import { proxyFetch } from '../utils/proxy.js';

// ── Contract addresses (Polygon mainnet) ──────────────────────────────────────

export const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
export const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e
export const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
export const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

// ── ABIs (minimal) ────────────────────────────────────────────────────────────

const SAFE_ABI = [
    'function nonce() view returns (uint256)',
    'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)',
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
];

// Minimum shares per side (Polymarket allows fractional; we enforce 2.5 as practical floor)
export const MIN_SHARES_PER_SIDE = 2.5;

const CTF_ABI = [
    'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
    'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 outcomeIndex) view returns (uint256)',
];

const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
];

const ERC1155_ABI = [
    'function isApprovedForAll(address account, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved)',
];

// ── Error helpers ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Convert a raw ethers.js / RPC error into a short, human-readable message.
 * Strips the lengthy internal stack info that ethers appends.
 */
function parseOnchainError(err) {
    const msg = err?.message || String(err);
    const reason = err?.reason || err?.error?.reason || '';

    if (msg.includes('insufficient funds') || msg.includes('insufficient balance'))
        return 'Insufficient MATIC balance for gas fees';
    if (msg.includes('nonce too low') || msg.includes('nonce has already been used'))
        return 'Transaction nonce conflict (nonce already used)';
    if (msg.includes('replacement transaction underpriced'))
        return 'Gas price too low to replace previous transaction';
    if (msg.includes('gas tip cap') && msg.includes('minimum needed'))
        return 'Priority fee below Polygon minimum (25 Gwei)';
    if (msg.includes('UNPREDICTABLE_GAS_LIMIT'))
        return 'Gas estimation failed — transaction will likely revert';
    if (msg.includes('GS026'))
        return 'Safe nonce conflict (GS026) — another transaction consumed this nonce';
    if (msg.includes('GS013'))
        return 'Safe execution failed (GS013) — inner transaction reverted';
    if (msg.includes('execution reverted') || err?.code === 'CALL_EXCEPTION')
        return reason ? `Transaction reverted: ${reason}` : 'Transaction reverted by smart contract';
    if (msg.includes('timeout') || msg.includes('TIMEOUT'))
        return 'RPC request timed out';
    if (msg.includes('SERVER_ERROR') || msg.includes('Internal Server Error'))
        return 'RPC server error';
    if (msg.includes('NETWORK_ERROR') || msg.includes('network changed'))
        return 'Network connection lost';
    if (msg.includes('ECONNREFUSED') || msg.includes('connection refused'))
        return 'Cannot connect to Polygon RPC';
    if (msg.includes('header not found'))
        return 'RPC node not synced — please retry';

    // Fallback: extract the first sentence before ethers noise
    const first = msg.split('\n')[0].split('(')[0].trim();
    return first.length > 120 ? first.slice(0, 120) + '…' : (first || 'Unknown error');
}

// ── Safe transaction executor ─────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAY = 3000; // ms

// Gnosis Safe nonces are sequential — concurrent calls would read the same nonce
// and cause "nonce too low" for all but the first. This queue ensures every on-chain
// tx waits for the previous one to fully confirm before starting.
let _txQueue = Promise.resolve();

// Track whether a strategy (split/merge) tx is in progress so the redeemer can defer
let _strategyTxActive = false;

/**
 * Execute an arbitrary call through the Gnosis Safe proxy wallet.
 * Calls are serialized via an internal queue so nonces never collide.
 * Retries up to MAX_RETRIES times on transient errors.
 *
 * @param {string}  to          - Contract address
 * @param {string}  data        - Encoded calldata
 * @param {string}  description - Human-readable label for logging
 * @param {object}  [opts]      - Options
 * @param {boolean} [opts.priority=true] - Priority calls (strategy split/merge) run immediately.
 *                                         Non-priority calls (redeemer) wait until no strategy tx is active.
 */
export function execSafeCall(to, data, description = '', opts = {}) {
    const { priority = true, gasLimit } = opts;

    const job = async () => {
        // Non-priority (redeemer): wait if a strategy tx is active
        if (!priority && _strategyTxActive) {
            logger.info(`MM: deferring non-priority tx (${description}) — strategy tx in progress`);
            // Wait until strategy tx finishes (poll every 1s, max 60s)
            for (let i = 0; i < 60 && _strategyTxActive; i++) {
                await sleep(1000);
            }
        }

        if (priority) _strategyTxActive = true;
        try {
            return await _doExecSafeCall(to, data, description, gasLimit);
        } finally {
            if (priority) _strategyTxActive = false;
        }
    };

    // Enqueue: this call will only start after the previous one resolves/rejects
    const result = _txQueue.then(job);
    // Don't let a failure poison the queue for subsequent calls
    _txQueue = result.catch(() => { });
    return result;
}

async function _doExecSafeCall(to, data, description = '', gasLimit = undefined) {
    if (description) logger.info(`MM: exec safe tx — ${description}`);

    let lastErr;
    // Track gas price multiplier for replacement transactions
    let gasMultiplier = 1;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const provider = await getPolygonProvider();
            const wallet = getSigner().connect(provider);
            const safe = new ethers.Contract(config.proxyWallet, SAFE_ABI, wallet);

            const nonce = await safe.nonce();

            // Get the Safe's typed transaction hash
            const txHash = await safe.getTransactionHash(
                to,
                0,                                    // value (ETH)
                data,
                0,                                    // operation: CALL
                0,                                    // safeTxGas
                0,                                    // baseGas
                0,                                    // gasPrice
                ethers.constants.AddressZero,         // gasToken
                ethers.constants.AddressZero,         // refundReceiver
                nonce,
            );

            // Sign the raw hash with the EOA signing key (no EIP-191 prefix)
            // Gnosis Safe v1.3.0 treats plain ECDSA signatures (v=27/28) on the tx hash directly
            const signingKey = new ethers.utils.SigningKey(config.privateKey);
            const rawSig = signingKey.signDigest(txHash);
            const signature = ethers.utils.joinSignature(rawSig);

            // Polygon requires maxPriorityFeePerGas ≥ 25 Gwei.
            // Use HIGH gas prices for fast inclusion — especially important for redeem.
            const feeData = await provider.getFeeData();

            // Increase gas price on retry to replace pending transaction
            // Base: use 150% of estimated fees for fast inclusion
            // Multiplier on retry: 1.5x → 3x → 6x
            const BASE_MULTIPLIER = 1.5;
            const currentMultiplier = BASE_MULTIPLIER * gasMultiplier;

            // Priority fee: minimum 50 Gwei, or 150%+ of estimate
            const MIN_TIP = ethers.utils.parseUnits('50', 'gwei');
            const estimatedTip = feeData.maxPriorityFeePerGas || MIN_TIP;
            const gasTip = estimatedTip.mul(Math.ceil(currentMultiplier * 100)).div(100).gt(MIN_TIP)
                ? estimatedTip.mul(Math.ceil(currentMultiplier * 100)).div(100)
                : MIN_TIP;

            // Max fee: use high ceiling to ensure inclusion
            const MAX_FEE_CAP = ethers.utils.parseUnits('1000', 'gwei');
            const estimatedMaxFee = feeData.maxFeePerGas || ethers.utils.parseUnits('500', 'gwei');
            const gasFeeCap = estimatedMaxFee.mul(Math.ceil(currentMultiplier * 100)).div(100).gt(MAX_FEE_CAP)
                ? MAX_FEE_CAP
                : estimatedMaxFee.mul(Math.ceil(currentMultiplier * 100)).div(100);

            const txOpts = { maxPriorityFeePerGas: gasTip, maxFeePerGas: gasFeeCap };
            if (gasLimit) txOpts.gasLimit = gasLimit;

            const tx = await safe.execTransaction(
                to, 0, data, 0, 0, 0, 0,
                ethers.constants.AddressZero,
                ethers.constants.AddressZero,
                signature,
                txOpts,
            );

            const receipt = await tx.wait();
            return receipt;

        } catch (err) {
            lastErr = err;
            const friendly = parseOnchainError(err);

            if (attempt < MAX_RETRIES) {
                // Increase gas multiplier for replacement transaction
                if (err?.message?.includes('replacement transaction underpriced') ||
                    err?.message?.includes('Gas price too low to replace')) {
                    gasMultiplier *= 2;
                    logger.warn(`MM: transaction failed (attempt ${attempt}/${MAX_RETRIES}): ${friendly} — increasing gas ${gasMultiplier}x and retrying...`);
                } else {
                    logger.warn(`MM: transaction failed (attempt ${attempt}/${MAX_RETRIES}): ${friendly} — retrying in ${RETRY_DELAY / 1000}s...`);
                }
                await sleep(RETRY_DELAY);
            }
        }
    }

    // All retries exhausted — throw a clean, human-readable error
    throw new Error(parseOnchainError(lastErr));
}

// ── Approval helpers ──────────────────────────────────────────────────────────

// In-memory approval cache — avoids redundant on-chain reads after first approval
let _usdcApproved = false;
const _exchangeApproved = new Set();   // exchange addresses already confirmed
const _exchangeApprovalFailed = new Set(); // exchanges where approval was attempted and failed — don't retry

/**
 * Ensure the CTF contract can spend USDC from the proxy wallet.
 */
async function ensureUsdcApproval(amountWei) {
    if (_usdcApproved) return;

    const provider = await getPolygonProvider();
    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
    const allowance = await usdc.allowance(config.proxyWallet, CTF_ADDRESS);
    if (allowance.gte(amountWei)) {
        _usdcApproved = true;
        return;
    }

    const iface = new ethers.utils.Interface(ERC20_ABI);
    const data = iface.encodeFunctionData('approve', [CTF_ADDRESS, ethers.constants.MaxUint256]);
    await execSafeCall(USDC_ADDRESS, data, 'approve USDC → CTF');
    _usdcApproved = true;
    logger.success('MM: USDC approved to CTF contract');
}

/**
 * Ensure the CTF exchange is an approved ERC1155 operator (needed for limit sell orders).
 * This is a one-time per-wallet setup. After the first check, in-memory caches prevent
 * redundant RPC calls. If approval fails once, it's cached as failed and won't be retried.
 */
export async function ensureExchangeApproval(negRisk = false) {
    const exchange = negRisk ? NEG_RISK_EXCHANGE : CTF_EXCHANGE;
    if (_exchangeApproved.has(exchange)) return;
    if (_exchangeApprovalFailed.has(exchange)) return; // already tried and failed — skip

    try {
        const provider = await getPolygonProvider();
        const ctf = new ethers.Contract(CTF_ADDRESS, ERC1155_ABI, provider);

        const approved = await ctf.isApprovedForAll(config.proxyWallet, exchange);
        if (approved) {
            _exchangeApproved.add(exchange);
            logger.info(`CTF exchange already approved — skipping on-chain approval`);
            return;
        }

        // Not yet approved — execute setApprovalForAll once
        const iface = new ethers.utils.Interface(ERC1155_ABI);
        const data = iface.encodeFunctionData('setApprovalForAll', [exchange, true]);
        await execSafeCall(CTF_ADDRESS, data, 'setApprovalForAll → CTF Exchange');
        _exchangeApproved.add(exchange);
        logger.success(`CTF exchange approved as ERC1155 operator`);
    } catch (err) {
        _exchangeApprovalFailed.add(exchange);
        logger.warn(`CTF exchange approval failed — will not retry. Error: ${err.message}`);
        throw err;
    }
}

/**
 * Pre-approve both CTF exchanges at startup.
 * Call once after `initClient()`. If the wallet already has approvals set,
 * this is a cheap read-only check. If not, it executes the approval tx once.
 * Subsequent calls to `ensureExchangeApproval()` are no-ops.
 */
export async function preApproveExchanges() {
    logger.info('Checking CTF exchange approvals...');
    // Check both exchanges in parallel
    const results = await Promise.allSettled([
        ensureExchangeApproval(false), // CTF_EXCHANGE
        ensureExchangeApproval(true),  // NEG_RISK_EXCHANGE
    ]);
    const ok = results.filter(r => r.status === 'fulfilled').length;
    const fail = results.filter(r => r.status === 'rejected').length;
    if (ok > 0) logger.success(`CTF approvals: ${ok} OK, ${fail} skipped (already approved or failed)`);
    if (fail > 0) logger.warn(`${fail} CTF approval(s) failed — copy trading will still work, but limit sell orders may not`);
}

// ── Helper: Redeem after merge ───────────────────────────────────────────────

/**
 * Redeem positions for a specific conditionId (after successful merge).
 * This is a thin wrapper around redeemPositions to support auto-redeem.
 *
 * @param {string} conditionId - Market conditionId to redeem
 * @param {boolean} negRisk - Whether the market uses negRisk exchange
 */
export async function redeemPositions(conditionId, negRisk = false) {
    if (config.dryRun) {
        logger.info(`MM[SIM]: redeem positions for conditionId=${conditionId?.slice(0, 10)}...`);
        return;
    }

    // Pre-check: ensure market has resolved before calling redeemPositions.
    // If payoutDenominator == 0, the condition is unresolved — redeemPositions will
    // revert and the Safe wraps that as GS013. Throw a clear error instead.
    try {
        const provider = getPolygonProvider();
        const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
        const denominator = await ctf.payoutDenominator(conditionId);
        if (denominator.isZero()) {
            throw new Error(`Market not resolved yet (payoutDenominator=0) — cannot redeem conditionId=${conditionId?.slice(0, 12)}`);
        }
    } catch (err) {
        if (err.message.includes('payoutDenominator=0') || err.message.includes('not resolved')) throw err;
        // RPC error on pre-check — log and proceed anyway (let execSafeCall handle it)
        logger.warn(`MM: redeemPositions pre-check failed — ${err.message} — proceeding anyway`);
    }

    const ctfIface = new ethers.utils.Interface(CTF_ABI);
    const data = ctfIface.encodeFunctionData('redeemPositions', [
        USDC_ADDRESS,
        ethers.constants.HashZero,
        conditionId,
        [1, 2],
    ]);

    // gasLimit bypasses eth_estimateGas RPC flakiness (same reason as mergePositions).
    // GS013 without gasLimit = inner CTF call reverted, often due to gas estimation failure.
    await execSafeCall(CTF_ADDRESS, data, `redeemPositions ${conditionId?.slice(0, 12)}...`, { gasLimit: 500_000 });
}

// ── Core CTF operations ───────────────────────────────────────────────────────

/**
 * Split `amountUsdc` USDC into equal YES+NO conditional tokens via the CTF contract.
 *
 * This gives a flat $0.50 entry on BOTH sides with zero slippage:
 *   e.g. split $10 → 10 YES tokens + 10 NO tokens, each at $0.50 entry cost
 *
 * @param  {string} conditionId  - Market conditionId (bytes32 hex string)
 * @param  {number} amountUsdc   - Total USDC to split (both sides combined)
 * @param  {boolean} negRisk     - Whether the market uses negRisk exchange
 * @returns {number} shares      - Number of tokens per side (= amountUsdc)
 */
export async function splitPosition(conditionId, amountUsdc, negRisk = false) {
    // shares per side = amountUsdc (each token entry price = $0.50, so $10 gives 10 shares each side)
    const shares = amountUsdc;

    // Practical minimum: 2.5 shares per side → minimum $5 total (2 × $2.5)
    if (shares < MIN_SHARES_PER_SIDE) {
        throw new Error(
            `MM_TRADE_SIZE too small: ${shares} shares per side (minimum is ${MIN_SHARES_PER_SIDE}). ` +
            `Set MM_TRADE_SIZE ≥ ${MIN_SHARES_PER_SIDE} in your .env (current value: ${config.mmTradeSize}).`,
        );
    }

    if (config.dryRun) {
        logger.info(`MM[SIM]: split $${amountUsdc} USDC → ${shares} YES + ${shares} NO @ $0.50 each`);
        return shares;
    }

    const amountWei = ethers.utils.parseUnits(amountUsdc.toFixed(6), 6);

    // 1. Ensure USDC is approved to CTF contract
    await ensureUsdcApproval(amountWei);

    // 2. Ensure CTF exchange is approved to move tokens (needed for limit sells)
    await ensureExchangeApproval(negRisk);

    // 3. Call splitPosition on CTF contract
    const ctfIface = new ethers.utils.Interface(CTF_ABI);
    const data = ctfIface.encodeFunctionData('splitPosition', [
        USDC_ADDRESS,
        ethers.constants.HashZero, // parentCollectionId = bytes32(0) for root positions
        conditionId,
        [1, 2],                    // full binary partition: YES=indexSet(1), NO=indexSet(2)
        amountWei,
    ]);

    await execSafeCall(CTF_ADDRESS, data, `splitPosition conditionId=${conditionId.slice(0, 10)}...`);
    logger.success(`MM: split $${amountUsdc} USDC → ${shares} YES + ${shares} NO @ $0.50`);
    return shares;
}

/**
 * Merge equal YES+NO tokens back into USDC via the CTF contract.
 * Used for cut-loss when neither limit sell has been filled — recovers entry cost with no slippage.
 *
 * @param  {string} conditionId   - Market conditionId
 * @param  {number} sharesPerSide - How many tokens to merge (must be equal on both sides)
 * @returns {number} recoveredUsdc - USDC recovered (= sharesPerSide)
 */
export async function mergePositions(conditionId, sharesPerSide) {
    if (config.dryRun) {
        const recovered = sharesPerSide;
        logger.info(`MM[SIM]: merge ${sharesPerSide} YES+NO → $${recovered} USDC recovered`);
        return recovered;
    }

    // Floor to exact 6-decimal integer to prevent requesting more units than the Safe holds.
    // Floating point round-trip (e.g. 4.910199 → toFixed(4) → 4.9102 → 4910200 wei)
    // can exceed actual on-chain balance by 1 unit, causing the CTF merge to revert.
    const amountWei = ethers.utils.parseUnits(
        (Math.floor(sharesPerSide * 1_000_000) / 1_000_000).toFixed(6),
        6,
    );

    const ctfIface = new ethers.utils.Interface(CTF_ABI);
    const data = ctfIface.encodeFunctionData('mergePositions', [
        USDC_ADDRESS,
        ethers.constants.HashZero,
        conditionId,
        [1, 2],
        amountWei,
    ]);

    // Pass explicit gasLimit to bypass eth_estimateGas — Polygon RPC instability
    // can cause estimateGas to fail even when the tx would succeed onchain.
    // 500k gas is well above the ~200-250k typically consumed by a Safe+CTF merge.
    await execSafeCall(CTF_ADDRESS, data, `mergePositions conditionId=${conditionId.slice(0, 10)}...`, { gasLimit: 500_000 });
    logger.success(`MM: merged — recovered $${sharesPerSide} USDC`);
    return sharesPerSide;
}

/**
 * Cleanup on startup: find any open CTF token positions in the proxy wallet
 * and merge them back to USDC so we start with a clean slate.
 *
 * Strategy:
 *  1. Query Data API for the proxy wallet's open positions
 *  2. For each conditionId found, check on-chain ERC1155 balances for YES and NO tokens
 *  3. If the market is NOT yet resolved (payoutDenominator == 0), merge equal YES+NO back to USDC
 *  4. Cancel any open CLOB orders via the CLOB client
 *
 * @param {import('@polymarket/clob-client').ClobClient} clobClient
 */
export async function cleanupOpenPositions(clobClient) {
    logger.info('MM: scanning for leftover positions to clean up...');

    // ── 1. Cancel all open CLOB orders ──────────────────────────────────────────
    try {
        if (!config.dryRun) {
            const openOrders = await clobClient.getOpenOrders();
            if (Array.isArray(openOrders) && openOrders.length > 0) {
                logger.warn(`MM: cancelling ${openOrders.length} dangling open order(s)...`);
                for (const order of openOrders) {
                    try { await clobClient.cancelOrder({ orderID: order.id ?? order.order_id }); } catch { /* ignore */ }
                }
                logger.success('MM: all open orders cancelled');
            }
        }
    } catch (err) {
        logger.warn('MM: could not fetch open orders:', err.message);
    }

    // ── 2. Query Data API for proxy wallet positions ─────────────────────────────
    let dataPositions = [];
    try {
        const url = `https://data-api.polymarket.com/positions?user=${config.proxyWallet}`;
        const resp = await proxyFetch(url);
        if (resp.ok) dataPositions = await resp.json();
        if (!Array.isArray(dataPositions)) dataPositions = [];
    } catch (err) {
        logger.warn('MM: could not fetch positions from Data API:', err.message);
        return;
    }

    if (dataPositions.length === 0) {
        logger.info('MM: no open positions found — starting clean ✅');
        return;
    }

    logger.warn(`MM: found ${dataPositions.length} open position(s) — attempting to merge back to USDC...`);

    const provider = await getPolygonProvider();
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);

    // Group by conditionId
    const byCondition = new Map();
    for (const pos of dataPositions) {
        const cid = pos.conditionId || pos.condition_id;
        const tid = pos.asset || pos.tokenId || pos.token_id;
        if (!cid || !tid) continue;
        if (!byCondition.has(cid)) byCondition.set(cid, []);
        byCondition.get(cid).push({ tokenId: String(tid), size: parseFloat(pos.size || pos.currentValue || '0') });
    }

    let mergedCount = 0;
    for (const [conditionId, tokens] of byCondition) {
        try {
            // Check if market is already resolved (skip if so — redeemer handles those)
            const denominator = await ctf.payoutDenominator(conditionId);
            if (!denominator.isZero()) {
                logger.info(`MM: conditionId ${conditionId.slice(0, 10)}... already resolved — skipping (redeemer will handle)`);
                continue;
            }

            // Check on-chain ERC1155 token balances for each token
            const balances = await Promise.all(
                tokens.map(({ tokenId }) =>
                    ctf.balanceOf(config.proxyWallet, tokenId).then((b) => ({
                        tokenId,
                        shares: parseFloat(ethers.utils.formatUnits(b, 6)),
                        raw: b,
                    }))
                )
            );

            const nonZero = balances.filter((b) => b.shares >= MIN_SHARES_PER_SIDE);
            if (nonZero.length < 2) {
                logger.info(`MM: conditionId ${conditionId.slice(0, 10)}... balance too low to merge — skipping`);
                continue;
            }

            // Use the minimum balance across both sides as the merge amount
            const minShares = Math.min(...nonZero.map((b) => b.shares));
            logger.warn(`MM: merging ${minShares.toFixed(3)} YES+NO → USDC for ${conditionId.slice(0, 10)}...`);

            if (!config.dryRun) {
                await mergePositions(conditionId, minShares);
                mergedCount++;
            } else {
                logger.info(`MM[SIM]: would merge ${minShares.toFixed(3)} shares for ${conditionId.slice(0, 10)}...`);
            }
        } catch (err) {
            logger.error(`MM: failed to clean up ${conditionId.slice(0, 10)}... — ${parseOnchainError(err)}`);
        }
    }

    if (mergedCount > 0) {
        logger.success(`MM: cleanup complete — merged ${mergedCount} position(s) back to USDC ✅`);
    } else {
        logger.info('MM: cleanup done — nothing needed merging ✅');
    }
}

// ── Periodic redeemer ─────────────────────────────────────────────────────────

/**
 * Check all positions held by the proxy wallet, find resolved markets,
 * and call redeemPositions via the Safe to collect USDC.
 *
 * Covers recovery buy positions, residual tokens from splits, and anything
 * else that resolved without being sold through the CLOB.
 *
 * Called automatically every redeemInterval seconds from mm.js.
 */
export async function redeemMMPositions() {
    // 1. Query Data API for all positions held by the proxy wallet
    let dataPositions = [];
    try {
        const resp = await proxyFetch(`${config.dataHost}/positions?user=${config.proxyWallet}`);
        if (resp.ok) dataPositions = await resp.json();
        if (!Array.isArray(dataPositions)) dataPositions = [];
    } catch {
        return; // silent — will retry next interval
    }

    if (dataPositions.length === 0) return;

    const provider = await getPolygonProvider();
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
    const ctfIface = new ethers.utils.Interface(CTF_ABI);

    // Group tokens by conditionId
    const byCondition = new Map();
    for (const pos of dataPositions) {
        const cid = pos.conditionId || pos.condition_id;
        const tid = pos.asset || pos.tokenId || pos.token_id;
        if (!cid || !tid) continue;
        if (!byCondition.has(cid)) byCondition.set(cid, []);
        byCondition.get(cid).push({
            tokenId: String(tid),
            size: parseFloat(pos.size || pos.currentValue || '0'),
        });
    }

    let redeemed = 0;

    for (const [conditionId, tokens] of byCondition) {
        try {
            // Skip unresolved markets
            const denominator = await ctf.payoutDenominator(conditionId);
            if (denominator.isZero()) continue;

            // Check actual on-chain token balances (positions API can lag)
            const balances = await Promise.all(
                tokens.map(({ tokenId }) =>
                    ctf.balanceOf(config.proxyWallet, tokenId)
                        .then((b) => parseFloat(ethers.utils.formatUnits(b, 6)))
                )
            );
            const totalShares = balances.reduce((a, b) => a + b, 0);
            if (totalShares < 0.001) continue; // nothing on-chain to redeem

            // Estimate payout from numerators (for logging only)
            const payoutFractions = await Promise.all(
                [0, 1].map((i) =>
                    ctf.payoutNumerators(conditionId, i)
                        .then((n) => n.toNumber() / denominator.toNumber())
                )
            );
            const expectedUsdc = balances.reduce(
                (sum, shares, i) => sum + shares * (payoutFractions[i] ?? 0), 0
            );

            const label = conditionId.slice(0, 12) + '...';

            if (config.dryRun) {
                logger.money(`MM[SIM] redeem: ${label} — ${totalShares.toFixed(3)} shares → ~$${expectedUsdc.toFixed(2)} USDC`);
                continue;
            }

            logger.info(`MM redeemer: ${label} resolved — ${totalShares.toFixed(3)} shares → ~$${expectedUsdc.toFixed(2)} USDC`);

            // Call redeemPositions through Safe (indexSets [1,2] covers both YES and NO)
            const data = ctfIface.encodeFunctionData('redeemPositions', [
                USDC_ADDRESS,
                ethers.constants.HashZero,
                conditionId,
                [1, 2],
            ]);
            await execSafeCall(CTF_ADDRESS, data, `redeemPositions ${label}`, { priority: false });
            logger.money(`MM redeemer: redeemed ${label} → ~$${expectedUsdc.toFixed(2)} USDC`);
            redeemed++;
        } catch (err) {
            logger.error(`MM redeemer: failed to redeem ${conditionId.slice(0, 12)}... — ${parseOnchainError(err)}`);
        }
    }

    if (redeemed > 0) {
        logger.success(`MM redeemer: collected ${redeemed} resolved position(s)`);
    }
}

// ── Sniper-specific redeemer ──────────────────────────────────────────────────

// Track conditionIds that repeatedly fail or are losses to avoid retrying every cycle
const _failedConditions = new Set();
const _skippedLosses = new Set();

// Callback invoked when a win is detected — receives conditionId
let _onWinCallback = null;

// Function to look up conditionId → { asset, yesTokenId, noTokenId }
// Injected from sniper entry point to avoid circular imports
let _getConditionInfo = null;

/**
 * Register a callback to be called when a sniper win is detected.
 * Callback signature: (conditionId: string) => void
 */
export function onSniperWin(cb) {
    _onWinCallback = cb;
}

/**
 * Register a function to look up sniper condition info (token mapping).
 * Used to correctly map token balances to outcome indices.
 */
export function setSniperConditionLookup(fn) {
    _getConditionInfo = fn;
}

/**
 * Redeem sniper positions via Gnosis Safe.
 * Only redeems WINNING positions — skip losses (they can be manually cleared).
 * Runs on interval only (no startup check) to catch new winners.
 */
export async function redeemSniperPositions() {
    // 1. Query Data API for all positions held by the proxy wallet
    let dataPositions = [];
    try {
        const resp = await proxyFetch(`${config.dataHost}/positions?user=${config.proxyWallet}`);
        if (!resp.ok) {
            logger.warn(`SNIPER redeemer: Data API returned ${resp.status} — will retry`);
            return;
        }
        dataPositions = await resp.json();
        if (!Array.isArray(dataPositions)) dataPositions = [];
    } catch (err) {
        logger.warn(`SNIPER redeemer: Data API fetch failed — ${err.message}`);
        return;
    }

    if (dataPositions.length === 0) return;

    const provider = await getPolygonProvider();
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
    const ctfIface = new ethers.utils.Interface(CTF_ABI);

    // Group tokens by conditionId
    const byCondition = new Map();
    for (const pos of dataPositions) {
        const cid = pos.conditionId || pos.condition_id;
        const tid = pos.asset || pos.tokenId || pos.token_id;
        if (!cid || !tid) continue;
        if (!byCondition.has(cid)) byCondition.set(cid, []);
        byCondition.get(cid).push({
            tokenId: String(tid),
            size: parseFloat(pos.size || pos.currentValue || '0'),
        });
    }

    let redeemed = 0;
    let skippedUnresolved = 0;
    let skippedLosses = 0;
    let skippedNoBalance = 0;

    for (const [conditionId, tokens] of byCondition) {
        // Fast skip: conditionIds that previously failed on-chain or confirmed losses
        if (_failedConditions.has(conditionId)) continue;
        if (_skippedLosses.has(conditionId)) {
            skippedLosses++;
            continue;
        }

        try {
            // Skip unresolved markets (fast check)
            const denominator = await ctf.payoutDenominator(conditionId);
            if (denominator.isZero()) {
                skippedUnresolved++;
                continue;
            }

            // Check actual on-chain token balances (positions API can lag)
            const balances = await Promise.all(
                tokens.map(({ tokenId }) =>
                    ctf.balanceOf(config.proxyWallet, tokenId)
                        .then((b) => parseFloat(ethers.utils.formatUnits(b, 6)))
                )
            );
            const totalShares = balances.reduce((a, b) => a + b, 0);
            if (totalShares < 0.001) {
                skippedNoBalance++;
                continue;
            }

            // Check outcome via payoutNumerators — which outcome index won?
            const payoutNums = await Promise.all(
                [0, 1].map((i) =>
                    ctf.payoutNumerators(conditionId, i).then((n) => n.toNumber())
                )
            );
            const denom = denominator.toNumber();
            const payoutFractions = payoutNums.map((n) => n / denom);

            // Determine winning outcome index (the one with payoutFraction > 0)
            const winningOutcome = payoutFractions[0] > 0 ? 0 : payoutFractions[1] > 0 ? 1 : -1;

            const label = conditionId.slice(0, 12) + '...';

            // Map token balances to outcome indices using sniper's token mapping.
            // yesTokenId = outcome 0 (clobTokenIds[0]), noTokenId = outcome 1
            const sniperInfo = _getConditionInfo ? _getConditionInfo(conditionId) : null;

            // Build outcome→balance mapping (keyed by outcome index, not array index)
            const outcomeBalances = [0, 0];
            if (sniperInfo) {
                for (let i = 0; i < tokens.length; i++) {
                    if (tokens[i].tokenId === sniperInfo.yesTokenId) outcomeBalances[0] = balances[i];
                    else if (tokens[i].tokenId === sniperInfo.noTokenId) outcomeBalances[1] = balances[i];
                }
            } else {
                // No sniper mapping — skip (not a sniper position)
                continue;
            }

            // Win = we hold shares on the winning outcome side
            const winShares = winningOutcome >= 0 ? outcomeBalances[winningOutcome] : 0;
            const isWin = winShares > 0;
            const expectedUsdc = outcomeBalances.reduce(
                (sum, shares, i) => sum + shares * (payoutFractions[i] ?? 0), 0
            );

            // SNIPER: only redeem WINNERS — cache losses to skip next time
            if (!isWin) {
                _skippedLosses.add(conditionId);
                if (config.dryRun) {
                    logger.info(`SNIPER[SIM] skip loss: ${label} — outcome=${winningOutcome}, win_shares=0 (cached)`);
                } else {
                    logger.info(`SNIPER redeemer: skip loss ${label} — outcome=${winningOutcome}, no shares on winner`);
                }
                continue;
            }

            // Track win for pause-after-win (notify via callback)
            if (_onWinCallback) _onWinCallback(conditionId);

            if (config.dryRun) {
                logger.money(`SNIPER[SIM] redeem: ${label} — ${winShares.toFixed(3)} shares on outcome ${winningOutcome} → ~$${expectedUsdc.toFixed(2)} USDC (WIN)`);
                continue;
            }

            logger.info(`SNIPER redeemer: ${label} resolved WIN — outcome ${winningOutcome}, ${winShares.toFixed(3)} shares → ~$${expectedUsdc.toFixed(2)} USDC`);

            // Call redeemPositions through Safe — winners only
            const data = ctfIface.encodeFunctionData('redeemPositions', [
                USDC_ADDRESS,
                ethers.constants.HashZero,
                conditionId,
                [1, 2],
            ]);
            const receipt = await execSafeCall(CTF_ADDRESS, data, `redeemPositions ${label}`, { priority: false });

            logger.money(`SNIPER redeemer: redeemed ${label} → ~$${expectedUsdc.toFixed(2)} USDC ✅ | tx: ${receipt.transactionHash}`);
            redeemed++;
        } catch (err) {
            const friendly = parseOnchainError(err);
            logger.error(`SNIPER redeemer: failed ${conditionId.slice(0, 12)}... — ${friendly}`);
            // Don't retry this conditionId next cycle — it will keep failing
            _failedConditions.add(conditionId);
            logger.warn(`SNIPER redeemer: skipping ${conditionId.slice(0, 12)}... in future cycles`);
        }
    }

    // Summary log
    const totalSkipped = skippedUnresolved + skippedLosses + skippedNoBalance + _skippedLosses.size + _failedConditions.size;
    if (redeemed > 0 || totalSkipped > 0) {
        logger.info(`SNIPER redeemer: ${redeemed} redeemed, ${_skippedLosses.size} losses cached, ${skippedUnresolved} unresolved skipped`);
    }
}
