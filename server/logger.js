import { transports, createLogger, format } from 'winston';
import 'winston-daily-rotate-file';
import * as fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsPromises } from 'fs';

// Load .env early to ensure log paths are available even if the entrypoint loads env later
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
  // Ignore missing .env; fall back to defaults or process env
}

// Paths for application (general) and audit (detailed) logs
const fallbackLogPath = '/data/admin/application-%DATE%.log';
const fallbackAuditPath = '/data/admin/audit-%DATE%.log';
const fallbackUserLogDir = path.join('/data/admin', 'users');
const logPath = process.env.LOG_PATH || fallbackLogPath;
const auditPath = process.env.AUDIT_LOG_PATH || fallbackAuditPath;
const userLogDir = process.env.USER_LOG_DIR || fallbackUserLogDir;

try {
  if (!process.env.LOG_PATH) {
    console.info(`[Logging] LOG_PATH not set, falling back to ${fallbackLogPath}`);
  }
  if (!process.env.AUDIT_LOG_PATH) {
    console.info(`[Logging] AUDIT_LOG_PATH not set, falling back to ${fallbackAuditPath}`);
  }
  if (!process.env.USER_LOG_DIR) {
    console.info(`[Logging] USER_LOG_DIR not set, falling back to ${fallbackUserLogDir}`);
  }
} catch {}

// Ensure directories exist
const ensureDir = (targetPath) => {
  if (!targetPath) return;
  const dir = path.dirname(targetPath);
  if (!dir || dir === '.') return;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

ensureDir(logPath);
ensureDir(auditPath);
if (userLogDir && !fs.existsSync(userLogDir)) {
  fs.mkdirSync(userLogDir, { recursive: true });
}

// Log destinations to console for visibility
try {
  console.info('[Logging] Destinations', { app: logPath, audit: auditPath, users: userLogDir });
} catch {}

const appFileTransport = new transports.DailyRotateFile({
  filename: logPath,
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d'
});

const auditFileTransport = new transports.DailyRotateFile({
  filename: auditPath,
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '30d'
});

const consoleTransport = new transports.Console({
  format: format.combine(
    format((info) => (info.console ? info : false))(),
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.colorize(),
    format.printf(info => {
      const userLabel = info.user || info.username || info.uid || 'anonymous';
      const action = info.action || info.message;
      return `${info.timestamp} ${info.level}: [${userLabel}] ${action}`;
    })
  )
});

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [consoleTransport, appFileTransport]
});

const auditLogger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [auditFileTransport]
});

// Append per-user audit events to rotated files (one file per user per day)
const logUserEvent = async (uid, event, data = {}) => {
  if (!uid) return;
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const filePath = path.join(userLogDir, `${uid}-${dateStr}.log`);
  const entry = {
    timestamp: now.toISOString(),
    uid,
    event,
    ...data
  };
  try {
    await fsPromises.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    // Swallow errors to avoid impacting the main flow
  }
};

export { auditLogger, logUserEvent };
export default logger;
