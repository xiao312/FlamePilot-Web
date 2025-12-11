import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env early so USER_DATA_ROOT is available when this module initializes
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
try {
  const envPath = path.join(__dirname, '../.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const [key, ...rest] = trimmed.split('=');
    if (key && rest.length && !process.env[key]) {
      process.env[key] = rest.join('=').trim();
    }
  });
} catch {
  // Ignore if .env is missing; will fall back to defaults
}

const DEFAULT_ROOT_BASE = '/data/flamepilot/usr';
const DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024; // 5GB default
const USER_QUOTA_BYTES = Number(process.env.USER_QUOTA_BYTES || DEFAULT_QUOTA_BYTES);

let rootLogged = false;
let quotaLogged = false;

export function getUserRoot(uid) {
// Prefer explicit per-user root, fall back to SHELL_ROOT, then default
let base = process.env.USER_DATA_ROOT || process.env.SHELL_ROOT || DEFAULT_ROOT_BASE;
  if (!rootLogged) {
    if (process.env.USER_DATA_ROOT) {
      console.info(`[Storage] Using USER_DATA_ROOT=${process.env.USER_DATA_ROOT}`);
    } else if (process.env.SHELL_ROOT) {
      console.info(`[Storage] USER_DATA_ROOT not set, falling back to SHELL_ROOT=${process.env.SHELL_ROOT}`);
    } else {
      console.info(`[Storage] USER_DATA_ROOT and SHELL_ROOT not set, falling back to default ${DEFAULT_ROOT_BASE}`);
    }
    rootLogged = true;
  }
  return path.join(base, String(uid || 'anonymous'));
}

export function ensureUserRoot(uid) {
  const root = getUserRoot(uid);
  const subdirs = [
    root,
    path.join(root, '.flamepilot'),
    path.join(root, '.flamepilot', 'projects')
  ];
  subdirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
  return root;
}

export function getQuotaLimitBytes() {
  if (!quotaLogged && !process.env.USER_QUOTA_BYTES) {
    console.info(`[Storage] USER_QUOTA_BYTES not set, using default ${DEFAULT_QUOTA_BYTES} bytes (5GB)`);
    quotaLogged = true;
  }
  return USER_QUOTA_BYTES;
}

export function getQuotaUsageBytes(uid) {
  const root = getUserRoot(uid);
  try {
    // Use sync to avoid extra dependencies; dirs are small-ish
    const du = dirSize(root);
    return du;
  } catch {
    return 0;
  }
}

export function isOverQuota(uid) {
  return getQuotaUsageBytes(uid) >= USER_QUOTA_BYTES;
}

function dirSize(targetPath) {
  let total = 0;
  if (!fs.existsSync(targetPath)) return 0;
  const stats = fs.statSync(targetPath);
  if (stats.isFile()) {
    return stats.size;
  }
  const entries = fs.readdirSync(targetPath);
  for (const entry of entries) {
    const full = path.join(targetPath, entry);
    const s = fs.statSync(full);
    if (s.isDirectory()) {
      total += dirSize(full);
    } else {
      total += s.size;
    }
  }
  return total;
}

export function quotaGuard(uid) {
  if (isOverQuota(uid)) {
    const err = new Error('User is over disk quota');
    err.status = 403;
    err.statusCode = 403;
    err.code = 'OVER_QUOTA';
    err.quota = {
      used: getQuotaUsageBytes(uid),
      limit: getQuotaLimitBytes()
    };
    throw err;
  }
}
