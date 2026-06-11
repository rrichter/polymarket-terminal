/**
 * patch-clob-client-v2.cjs
 *
 * Patches @polymarket/clob-client-v2 to inject proxy support.
 * Runs automatically via `npm install` (postinstall hook).
 *
 * What it does:
 *   - Searches for the V2 SDK's internal HTTP/axios layer
 *   - If axios-based: injects proxy agent interceptor for polymarket.com
 *   - If fetch-based: no patch needed (proxy handled via undici ProxyAgent in proxy.js)
 *   - Reads PROXY_URL from process.env at runtime
 */

const fs = require('fs');
const path = require('path');

const BASE = path.join(
    __dirname,
    '..',
    'node_modules',
    '@polymarket',
    'clob-client-v2',
);

// ── Find the SDK's HTTP layer ──────────────────────────────────────────────

// V2 may use different internal paths than V1. Try common patterns.
const CANDIDATES = [
    'dist/http-helpers/index.js',   // V1-style layout
    'dist/http-helpers/index.cjs',  // CJS variant
    'dist/http/index.js',           // Simplified layout
    'dist/http/index.cjs',
    'dist/index.js',                // Monolithic build
    'dist/index.cjs',
];

let TARGET = null;
for (const candidate of CANDIDATES) {
    const full = path.join(BASE, candidate);
    if (fs.existsSync(full)) {
        // Only patch files that contain axios references
        const content = fs.readFileSync(full, 'utf8');
        if (content.includes('axios') || content.includes('httpAgent') || content.includes('polymarket.com')) {
            TARGET = full;
            console.log('[patch-v2] Found HTTP layer:', candidate);
            break;
        }
    }
}

if (!TARGET) {
    console.log('[patch-v2] @polymarket/clob-client-v2 HTTP layer not found or not axios-based — skipping (proxy handled by proxy.js)');
    process.exit(0);
}

let code = fs.readFileSync(TARGET, 'utf8');

// Check if proxy support is already patched
const proxyAlreadyPatched = code.includes('getProxyAgent');

// ── Proxy interceptor ──────────────────────────────────────────────────────

if (!proxyAlreadyPatched) {
    const PATCH_CODE = `
// ── Proxy support (auto-patched by scripts/patch-clob-client-v2.cjs) ─────
const https_proxy_agent_1 = require("https-proxy-agent");
let _cachedProxyAgent = null;
const getProxyAgent = () => {
    if (!process.env.PROXY_URL) return undefined;
    if (!_cachedProxyAgent) {
        _cachedProxyAgent = new https_proxy_agent_1.HttpsProxyAgent(process.env.PROXY_URL);
    }
    return _cachedProxyAgent;
};
// Intercept all axios requests — inject proxy agent for polymarket.com
axios_1.default.interceptors.request.use(function(cfg) {
    if (cfg.url && cfg.url.includes('polymarket.com')) {
        var agent = getProxyAgent();
        if (agent) {
            cfg.httpsAgent = agent;
            cfg.httpAgent = agent;
            cfg.proxy = false;
        }
    }
    return cfg;
});
// ── End proxy patch ───────────────────────────────────────────────────────
`;
    const axiosPatterns = [
        /tslib_1\.__importDefault\s*\(\s*require\s*\(\s*["']axios["']\s*\)\s*\)\s*;/,
        /require\s*\(\s*["']axios["']\s*\)\s*;/,
    ];
    let injected = false;
    for (const pattern of axiosPatterns) {
        const match = code.match(pattern);
        if (match) {
            code = code.replace(match[0], match[0] + PATCH_CODE);
            console.log('[patch-v2] Injected proxy interceptor after axios import');
            injected = true;
            break;
        }
    }
    if (!injected) {
        console.log('[patch-v2] No axios import found — proxy handled externally (proxy.js)');
    }
} else {
    console.log('[patch-v2] Proxy support already present — skipping');
}

// ── Fix errorHandling circular JSON (if present) ───────────────────────────

const configPattern = /config:\s*\(_d\s*=\s*err\.response\)/;
const jsonFixAlreadyPatched = !configPattern.test(code);

if (!jsonFixAlreadyPatched) {
    const OLD_LOG = `console.error("[CLOB Client] request error", JSON.stringify({
                status: (_a = err.response) === null || _a === void 0 ? void 0 : _a.status,
                statusText: (_b = err.response) === null || _b === void 0 ? void 0 : _b.statusText,
                data: (_c = err.response) === null || _c === void 0 ? void 0 : _c.data,
                config: (_d = err.response) === null || _d === void 0 ? void 0 : _d.config,
            }));`;
    const NEW_LOG = `// config excluded — contains httpsAgent circular refs (stack overflow)
            console.error("[CLOB Client] request error:", (_a = err.response) === null || _a === void 0 ? void 0 : _a.status, JSON.stringify((_b = err.response) === null || _b === void 0 ? void 0 : _b.data));`;
    if (code.includes(OLD_LOG)) {
        code = code.replace(OLD_LOG, NEW_LOG);
        console.log('[patch-v2] Fixed errorHandling circular JSON.stringify');
    } else {
        console.log('[patch-v2] Circular JSON fix not applicable — V2 may already handle this');
    }
} else {
    console.log('[patch-v2] Circular JSON fix not needed — V2 already safe');
}

fs.writeFileSync(TARGET, code, 'utf8');
console.log('[patch-v2] @polymarket/clob-client-v2 patched ✅');
