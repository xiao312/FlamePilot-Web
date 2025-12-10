import { transports, createLogger, format } from 'winston';
import 'winston-daily-rotate-file';
import * as fs from 'fs';
import path from 'path';
import { promises as fsPromises } from 'fs';

// Paths for application (general) and audit (detailed) logs
const logPath = process.env.LOG_PATH || 'logs/application-%DATE%.log';
const auditPath = process.env.AUDIT_LOG_PATH || 'logs/audit-%DATE%.log';
const userLogDir = process.env.USER_LOG_DIR || path.join('logs', 'users');

// Ensure directories exist
for (const p of [logPath, auditPath]) {
  const dir = p.split('/')[0];
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
if (!fs.existsSync(userLogDir)) {
  fs.mkdirSync(userLogDir, { recursive: true });
}

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
    format.colorize(),
    format.printf(info => {
      const userLabel = info.user || info.username || info.uid || 'anonymous';
      const action = info.action || info.message;
      return `[${userLabel}] ${action}`;
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
