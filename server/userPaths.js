import fs from 'fs';
import path from 'path';

const DEFAULT_ROOT_BASE = '/data';
const USER_QUOTA_BYTES = Number(process.env.USER_QUOTA_BYTES || 1_000_000_000); // default 1GB

export function getUserRoot(uid) {
  const base = process.env.USER_DATA_ROOT || DEFAULT_ROOT_BASE;
  return path.join(base, String(uid || 'anonymous'));
}

export function ensureUserRoot(uid) {
  const root = getUserRoot(uid);
  const subdirs = [
    root,
    path.join(root, '.gemini'),
    path.join(root, '.gemini', 'projects'),
    path.join(root, 'tmp'),
    path.join(root, 'logs')
  ];
  subdirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
  return root;
}

export function getQuotaLimitBytes() {
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
