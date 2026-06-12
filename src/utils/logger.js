// ANSI color codes (used in normal terminal mode)
const A = {
    reset:   '\x1b[0m',
    dim:     '\x1b[2m',
    red:     '\x1b[31m',
    green:   '\x1b[32m',
    yellow:  '\x1b[33m',
    blue:    '\x1b[34m',
    magenta: '\x1b[35m',
    cyan:    '\x1b[36m',
};

// Blessed tag pairs (used when dashboard is active)
const B = {
    red:     ['{red-fg}',     '{/red-fg}'],
    green:   ['{green-fg}',   '{/green-fg}'],
    yellow:  ['{yellow-fg}',  '{/yellow-fg}'],
    blue:    ['{blue-fg}',    '{/blue-fg}'],
    magenta: ['{magenta-fg}', '{/magenta-fg}'],
    cyan:    ['{cyan-fg}',    '{/cyan-fg}'],
};

let outputFn = null; // When set, all log goes here (blessed dashboard mode)

/**
 * Sanitize a CLOB client console message.
 * Strips the full axios config (which may contain auth headers) and returns
 * only the HTTP status code + API error message.
 */
function sanitizeClobMessage(raw) {
    if (!raw.includes('[CLOB Client]')) return raw;
    try {
        const jsonStart = raw.indexOf('{');
        if (jsonStart === -1) return raw;
        const parsed = JSON.parse(raw.slice(jsonStart));
        const status  = parsed.status  || '';
        const errMsg  = parsed.data?.error || parsed.statusText || 'unknown error';
        const prefix  = raw.slice(0, jsonStart).trim();
        return `${prefix}: ${status} — ${errMsg}`;
    } catch {
        return raw;
    }
}

function ts() {
    // "2026-06-12T01:31:27.123Z" → "2026-06-12 01:31:27.123"
    return new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 23);
}

function stringify(args) {
    return args.map((a) => (a && typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
}

function log(ansiColor, bColor, emoji, level, ...args) {
    const msg = stringify(args);
    if (outputFn) {
        const [open, close] = bColor;
        outputFn(`{gray-fg}[${ts()}]{/gray-fg} ${open}${emoji} ${level}${close} ${msg}`);
    } else {
        process.stdout.write(
            `${A.dim}[${ts()}]${A.reset} ${ansiColor}${emoji} ${level}${A.reset} ${msg}\n`,
        );
    }
}

const logger = {
    info:    (...a) => log(A.blue,    B.blue,    'ℹ️ ', 'INFO',    ...a),
    success: (...a) => log(A.green,   B.green,   '✅', 'SUCCESS', ...a),
    warn:    (...a) => log(A.yellow,  B.yellow,  '⚠️ ', 'WARN',    ...a),
    error:   (...a) => log(A.red,     B.red,     '❌', 'ERROR',   ...a),
    trade:   (...a) => log(A.magenta, B.magenta, '📊', 'TRADE',   ...a),
    watch:   (...a) => log(A.cyan,    B.cyan,    '👀', 'WATCH',   ...a),
    money:   (...a) => log(A.green,   B.green,   '💰', 'MONEY',   ...a),

    /** Call once after initDashboard() to redirect all logs to the TUI */
    setOutput(fn) {
        outputFn = fn;
    },

    /**
     * Override console.error and console.log globally so that the CLOB client's
     * internal axios error dumps are sanitized (no auth headers / full config).
     * Call this once at startup, before any CLOB requests.
     */
    interceptConsole() {
        const handle = (originalFn, logFn) => (...args) => {
            const raw = args.map((a) => (a && typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
            const sanitized = sanitizeClobMessage(raw);
            if (sanitized !== raw || raw.includes('[CLOB Client]')) {
                logFn(sanitized);
            } else {
                originalFn(...args);
            }
        };
        console.error = handle(console.error.bind(console), logger.error);
        console.warn  = handle(console.warn.bind(console),  logger.warn);
    },
};

export default logger;
