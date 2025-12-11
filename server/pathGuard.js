import fs from 'fs';
import path from 'path';

// Returns the resolved shell root path from env (or null if not set)
export function getShellRoot() {
  // Prefer USER_DATA_ROOT as the single source of truth; fall back to SHELL_ROOT for legacy
  const root = process.env.USER_DATA_ROOT || process.env.SHELL_ROOT;
  return root ? path.resolve(root) : null;
}

// Checks whether a given path is inside the configured shell root (if set)
export function isPathWithinShellRoot(targetPath) {
  const root = getShellRoot();
  if (!root) {
    return true; // No root configured, allow all
  }
  const resolvedTarget = path.resolve(targetPath);
  const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return resolvedTarget === root || resolvedTarget.startsWith(normalizedRoot);
}

// Throws if the path is outside the configured shell root
export function assertPathWithinShellRoot(targetPath, context = 'Path') {
  if (!targetPath) {
    const error = new Error(`${context} is required`);
    error.statusCode = 400;
    throw error;
  }
  const root = getShellRoot();
  if (!root) {
    return;
  }
  if (!isPathWithinShellRoot(targetPath)) {
    const error = new Error(`${context} must stay within SHELL_ROOT (${root})`);
    error.statusCode = 403;
    throw error;
  }
}

// Throws if a shell root is configured but missing on disk
export function ensureShellRootExists() {
  const root = getShellRoot();
  if (root && !fs.existsSync(root)) {
    const error = new Error(`Configured SHELL_ROOT does not exist: ${root}`);
    error.statusCode = 400;
    throw error;
  }
}
