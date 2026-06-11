import { ClobClient, Chain, SignatureTypeV2, AssetType } from '@polymarket/clob-client-v2';
import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { ethers, Wallet } from 'ethers';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { setupAxiosProxy, testProxy } from '../utils/proxy.js';

let clobClient = null;
let _walletClient = null;   // viem WalletClient (for CLOB signing)
let signer = null;          // ethers Wallet (for on-chain Safe transactions)
let _provider = null;       // singleton — reused across all onchain calls
let _apiCreds = null;       // API credentials (stored for user WS auth)

/**
 * Initialize the Polymarket CLOB client
 * Auto-derives API credentials if not provided in .env
 */
export async function initClient() {
    // ── Set up proxy (if configured) BEFORE any Polymarket API calls ──
    await setupAxiosProxy();

    // Test proxy connectivity
    const proxyOk = await testProxy();
    if (!proxyOk) {
        logger.error('Proxy test failed — cannot reach Polymarket. Exiting.');
        process.exit(1);
    }

    logger.info('Initializing Polymarket CLOB client (v2)...');

    // ── Create viem wallet client (for CLOB signing only — no RPC calls) ──
    const account = privateKeyToAccount(config.privateKey);
    _walletClient = createWalletClient({
        account,
        chain: polygon,
        transport: http(config.polygonRpcUrl),
    });

    // ── Create ethers Wallet (kept for on-chain Safe/CTF operations) ──
    signer = new Wallet(config.privateKey);

    logger.info(`EOA (signer)  : ${account.address}`);
    logger.info(`Proxy wallet  : ${config.proxyWallet}`);

    // Step 1: Create temp client to derive API credentials (L1 auth)
    let apiCreds;
    if (config.clobApiKey && config.clobApiSecret && config.clobApiPassphrase) {
        apiCreds = {
            key: config.clobApiKey,
            secret: config.clobApiSecret,
            passphrase: config.clobApiPassphrase,
        };
        logger.info('Using API credentials from .env');
    } else {
        const tempClient = new ClobClient({
            host: config.clobHost,
            chain: Chain.POLYGON,
            signer: _walletClient,
        });
        apiCreds = await tempClient.createOrDeriveApiKey();
        logger.info('API credentials derived successfully');
    }

    // Store for user WebSocket auth (needed by userWsWatcher)
    _apiCreds = apiCreds;

    // Step 2: Initialize full trading client (L1 + L2 auth)
    // signatureType: POLY_1271 = EIP-1271 smart contract signatures (Gnosis Safe)
    // funderAddress = proxy wallet where USDC.e is held
    clobClient = new ClobClient({
        host: config.clobHost,
        chain: Chain.POLYGON,
        signer: _walletClient,
        creds: apiCreds,
        signatureType: SignatureTypeV2.POLY_1271,
        funderAddress: config.proxyWallet,
        useServerTime: true,
        throwOnError: true,
    });

    logger.success('CLOB client initialized (v2)');
    return clobClient;
}

/**
 * Get the initialized CLOB client (v2)
 */
export function getClient() {
    if (!clobClient) {
        throw new Error('CLOB client not initialized. Call initClient() first.');
    }
    return clobClient;
}

/**
 * Get the viem WalletClient (for CLOB signing)
 */
export function getWalletClient() {
    if (!_walletClient) {
        throw new Error('Wallet client not initialized. Call initClient() first.');
    }
    return _walletClient;
}

/**
 * Get API credentials (for user WebSocket auth)
 */
export function getApiCredentials() {
    if (!_apiCreds) {
        throw new Error('CLOB client not initialized. Call initClient() first.');
    }
    return _apiCreds;
}

/**
 * Get the ethers Wallet signer (for on-chain Safe transactions)
 */
export function getSigner() {
    if (!signer) {
        throw new Error('Signer not initialized. Call initClient() first.');
    }
    return signer;
}

/**
 * Get (or create) the singleton Polygon provider.
 * A single JsonRpcProvider instance is reused across all onchain calls
 * to avoid reconnection overhead on every balance check.
 */
export function getPolygonProvider() {
    if (!_provider) {
        _provider = new ethers.providers.JsonRpcProvider(config.polygonRpcUrl);
    }
    return _provider;
}

/**
 * Get USDC.e balance of the proxy wallet on Polygon
 */
export async function getUsdcBalance() {
    const provider = getPolygonProvider();
    const usdcAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e on Polygon
    const abi = ['function balanceOf(address) view returns (uint256)'];
    const usdc = new ethers.Contract(usdcAddress, abi, provider);
    const balance = await usdc.balanceOf(config.proxyWallet);
    return parseFloat(ethers.utils.formatUnits(balance, 6));
}

/**
 * Get USDC balance from the CLOB REST API (L2 auth).
 * Queries Polymarket's /balance-allowance endpoint — returns your actual
 * account balance including funds held in the CLOB exchange.
 */
export async function getClobBalance() {
    const client = getClient();
    const result = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    // CLOB returns raw 6-decimal units (e.g. 84646550 = $84.65 USDC)
    return parseFloat(result?.balance ?? '0') / 1_000_000;
}
