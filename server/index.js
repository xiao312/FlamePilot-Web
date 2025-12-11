import logger from './logger.js';
// Load environment variables from .env file
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

try {
  const envPath = path.join(__dirname, '../.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      const [key, ...valueParts] = trimmedLine.split('=');
      if (key && valueParts.length > 0 && !process.env[key]) {
        process.env[key] = valueParts.join('=').trim();
      }
    }
  });
} catch (e) {
  // console.log('No .env file found or error reading it:', e.message);
}

// console.log('PORT from env:', process.env.PORT);

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import cors from 'cors';
import { promises as fsPromises } from 'fs';
import { spawn, execSync } from 'child_process';
import os from 'os';
import pty from 'node-pty';
import fetch from 'node-fetch';
import mime from 'mime-types';

import { getProjects, getSessions, getSessionMessages, renameProject, deleteSession, deleteProject, addProjectManually, extractProjectDirectory, clearProjectDirectoryCache } from './projects.js';
import { spawnGemini, abortGeminiSession } from './gemini-cli.js';
import sessionManager from './sessionManager.js';
import gitRoutes from './routes/git.js';
import authRoutes from './routes/auth.js';
import mcpRoutes from './routes/mcp.js';
import { initializeDatabase } from './database/db.js';
import { validateApiKey, authenticateToken, authenticateWebSocket } from './middleware/auth.js';
import { getShellRoot, isPathWithinShellRoot, assertPathWithinShellRoot, ensureShellRootExists } from './pathGuard.js';
import { ensureUserRoot, getUserRoot, quotaGuard, getQuotaUsageBytes, getQuotaLimitBytes } from './userPaths.js';

// File system watcher for projects folder
let projectsWatcher = null;
const connectedClients = new Set();

// Setup file system watcher for Gemini projects folder using chokidar
async function setupProjectsWatcher() {
  const chokidar = (await import('chokidar')).default;
  const geminiProjectsPath = path.join(process.env.HOME, '.gemini', 'projects');
  
  if (projectsWatcher) {
    projectsWatcher.close();
  }
  
  try {
    // Initialize chokidar watcher with optimized settings
    projectsWatcher = chokidar.watch(geminiProjectsPath, {
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/*.tmp',
        '**/*.swp',
        '**/.DS_Store'
      ],
      persistent: true,
      ignoreInitial: true, // Don't fire events for existing files on startup
      followSymlinks: false,
      depth: 10, // Reasonable depth limit
      awaitWriteFinish: {
        stabilityThreshold: 100, // Wait 100ms for file to stabilize
        pollInterval: 50
      }
    });

    // Debounce function to prevent excessive notifications
    let debounceTimer;
    const debouncedUpdate = async (eventType, filePath) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        try {
          // Clear project directory cache when files change
          clearProjectDirectoryCache();
          // Get updated projects list
          const updatedProjects = await getProjects();
          // Notify all connected clients about the project changes
          const updateMessage = JSON.stringify({
            type: 'projects_updated',
            projects: updatedProjects,
            timestamp: new Date().toISOString(),
            changeType: eventType,
            changedFile: path.relative(geminiProjectsPath, filePath)
          });
          connectedClients.forEach(client => {
            if (client.readyState === client.OPEN) {
              client.send(updateMessage);
            }
          });
        } catch (error) {
          // console.error('❌ Error handling project changes:', error);
        }
      }, 300); // 300ms debounce (slightly faster than before)
    };
    // Set up event listeners
    projectsWatcher
      .on('add', (filePath) => debouncedUpdate('add', filePath))
      .on('change', (filePath) => debouncedUpdate('change', filePath))
      .on('unlink', (filePath) => debouncedUpdate('unlink', filePath))
      .on('addDir', (dirPath) => debouncedUpdate('addDir', dirPath))
      .on('unlinkDir', (dirPath) => debouncedUpdate('unlinkDir', dirPath))
      .on('error', (error) => {
        // console.error('❌ Chokidar watcher error:', error);
      })
      .on('ready', () => {
      });
  } catch (error) {
    // console.error('❌ Failed to setup projects watcher:', error);
  }
}


const app = express();
const server = http.createServer(app);

// Log photon billing configuration on startup
const logPhotonConfig = () => {
  const isDevMode = process.env.PHOTON_DEV_MODE === '1';
  const isMock = process.env.PHOTON_MOCK === '1';
  const whitelist = (process.env.PHOTON_WHITELIST_ACCESS_KEYS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  const devAccessKeySet = isDevMode ? Boolean(process.env.DEV_ACCESS_KEY) : false;
  const clientNameSet = Boolean(process.env.CLIENT_NAME);
  const skuIdSet = Boolean(process.env.SKU_ID);
  const photonSkuSet = Boolean(process.env.PHOTON_SKU_ID);
  const billingEnabled = !isMock && (isDevMode ? (devAccessKeySet && clientNameSet && skuIdSet) : false);
  const whitelistActive = whitelist.length > 0;
  const whitelistPreview = whitelist.map(k => k ? `***${k.slice(-4)}` : k);
  logger.info('[Photon] Startup config', {
    action: 'photon_startup',
    PHOTON_DEV_MODE: process.env.PHOTON_DEV_MODE,
    PHOTON_MOCK: process.env.PHOTON_MOCK,
    DEV_ACCESS_KEY_SET: devAccessKeySet,
    CLIENT_NAME_SET: clientNameSet,
    SKU_ID_SET: skuIdSet,
    PHOTON_SKU_ID_SET: photonSkuSet,
    whitelist: whitelistPreview,
    mode: isMock ? 'mock' : (isDevMode ? 'dev' : 'prod'),
    billingEnabled,
    whitelistActive,
  });
};

// Single WebSocket server that handles both paths
const wss = new WebSocketServer({
  server,
  verifyClient: (info) => {
    // console.log('WebSocket connection attempt to:', info.req.url);
    // Extract token from query parameters or headers
    const url = new URL(info.req.url, 'http://localhost');
    const token = url.searchParams.get('token') ||
                  info.req.headers.authorization?.split(' ')[1];
    // Verify token
    const user = authenticateWebSocket(token);
    if (!user) {
      // console.log('❌ WebSocket authentication failed');
      return false;
    }
    // Store user info in the request for later use
    info.req.user = user;
    // console.log('✅ WebSocket authenticated for user:', user.username);
    return true;
  }
});

// WebSocket heartbeat to detect dead connections
function heartbeat() {
  this.isAlive = true;
}

function respondWithGuardError(res, error) {
  return res.status(error.statusCode || error.status || 403).json({ error: error.message });
}

const wsPingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

wss.on('close', () => clearInterval(wsPingInterval));

app.use(cors());
app.use(express.json());

// Optional API key validation (if configured)
app.use('/api', validateApiKey);

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// Git API Routes (protected)
app.use('/api/git', authenticateToken, gitRoutes);

// MCP API Routes (protected)
app.use('/api/mcp', authenticateToken, mcpRoutes);


// Static files served after API routes
app.use(express.static(path.join(__dirname, '../dist')));

// API Routes (protected)
app.get('/api/config', authenticateToken, (req, res) => {
  const host = req.headers.host || `${req.hostname}:${PORT}`;
  const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws';
  const uid = req.user?.username || req.user?.id || 'anonymous';
  const userRoot = getUserRoot(uid);

  // console.log('Config API called - Returning host:', host, 'Protocol:', protocol);

  res.json({
    serverPort: PORT,
    wsUrl: `${protocol}://${host}`,
    shellRoot: getShellRoot(),
    userRoot
  });
});

app.get('/api/projects', authenticateToken, async (req, res) => {
  try {
    const uid = req.user?.username || req.user?.id || 'anonymous';
    ensureUserRoot(uid);
    try {
      quotaGuard(uid);
    } catch (error) {
      return respondWithGuardError(res, error);
    }
    const projects = await getProjects(uid);
    const root = getShellRoot();
    const filteredProjects = root ? projects.filter(p => p.path && isPathWithinShellRoot(p.path)) : projects;
    res.json(filteredProjects);
  } catch (error) {
    if (error.statusCode || error.status) {
      return respondWithGuardError(res, error);
    }
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projects/:projectName/sessions', authenticateToken, async (req, res) => {
  try {
    const uid = req.user?.username || req.user?.id || 'anonymous';
    ensureUserRoot(uid);
    try {
      quotaGuard(uid);
    } catch (error) {
      return respondWithGuardError(res, error);
    }
    // Extract the actual project directory path
    const projectPath = await extractProjectDirectory(req.params.projectName, uid);
    try {
      ensureShellRootExists();
      assertPathWithinShellRoot(projectPath, 'Project path');
    } catch (error) {
      return respondWithGuardError(res, error);
    }
    // Get sessions from sessionManager
    const sessions = sessionManager.getProjectSessions(projectPath);
    // Apply pagination
    const { limit = 5, offset = 0 } = req.query;
    const paginatedSessions = sessions.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
    res.json({
      sessions: paginatedSessions,
      total: sessions.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get messages for a specific session
app.get('/api/projects/:projectName/sessions/:sessionId/messages', authenticateToken, async (req, res) => {
  try {
    const { projectName, sessionId } = req.params;
    const uid = req.user?.username || req.user?.id || 'anonymous';
    ensureUserRoot(uid);
    try {
      quotaGuard(uid);
    } catch (error) {
      return respondWithGuardError(res, error);
    }
    const messages = sessionManager.getSessionMessages(sessionId);
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rename project endpoint
app.put('/api/projects/:projectName/rename', authenticateToken, async (req, res) => {
  try {
    const { displayName } = req.body;
    try {
      const uid = req.user?.username || req.user?.id || 'anonymous';
      ensureUserRoot(uid);
      const projectPath = await extractProjectDirectory(req.params.projectName, uid);
      ensureShellRootExists();
      assertPathWithinShellRoot(projectPath, 'Project path');
    } catch (error) {
      return respondWithGuardError(res, error);
    }
    await renameProject(req.params.projectName, displayName);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete session endpoint
app.delete('/api/projects/:projectName/sessions/:sessionId', authenticateToken, async (req, res) => {
  try {
    const { projectName, sessionId } = req.params;
    const uid = req.user?.username || req.user?.id || 'anonymous';
    ensureUserRoot(uid);
    await sessionManager.deleteSession(sessionId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete project endpoint (only if empty)
app.delete('/api/projects/:projectName', authenticateToken, async (req, res) => {
  try {
    const { projectName } = req.params;
    try {
      const uid = req.user?.username || req.user?.id || 'anonymous';
      ensureUserRoot(uid);
      const projectPath = await extractProjectDirectory(projectName, uid);
      ensureShellRootExists();
      assertPathWithinShellRoot(projectPath, 'Project path');
    } catch (error) {
      return respondWithGuardError(res, error);
    }
    await deleteProject(projectName);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create project endpoint
app.post('/api/projects/create', authenticateToken, async (req, res) => {
  try {
    const uid = req.user?.username || req.user?.id || 'anonymous';
    ensureUserRoot(uid);
    const { path: projectPath } = req.body;
    if (!projectPath || !projectPath.trim()) {
      return res.status(400).json({ error: 'Project path is required' });
    }
    const resolvedPath = path.resolve(projectPath.trim());
    try {
      ensureShellRootExists();
      assertPathWithinShellRoot(resolvedPath, 'Project path');
    } catch (error) {
      return respondWithGuardError(res, error);
    }
    try {
      quotaGuard(uid);
    } catch (error) {
      return respondWithGuardError(res, error);
    }
    const project = await addProjectManually(resolvedPath);
    res.json({ success: true, project });
  } catch (error) {
    // console.error('Error creating project:', error);
    res.status(500).json({ error: error.message });
  }
});

// Read file content endpoint
app.get('/api/projects/:projectName/file', authenticateToken, async (req, res) => {
  try {
    const uid = req.user?.username || req.user?.id || 'anonymous';
    ensureUserRoot(uid);
    const { projectName } = req.params;
    const { filePath } = req.query;
    // console.log('📄 File read request:', projectName, filePath);
    // Using fsPromises from import
    // Security check - ensure the path is safe and absolute
    if (!filePath || !path.isAbsolute(filePath)) {
      return res.status(400).json({ error: 'Invalid file path' });
    }
    try {
      ensureShellRootExists();
      assertPathWithinShellRoot(filePath, 'File path');
    } catch (error) {
      return respondWithGuardError(res, error);
    }
    const content = await fsPromises.readFile(filePath, 'utf8');
    try {
      quotaGuard(uid);
    } catch (error) {
      return respondWithGuardError(res, error);
    }
    res.json({ content, path: filePath });
  } catch (error) {
    // console.error('Error reading file:', error);
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: 'File not found' });
    } else if (error.code === 'EACCES') {
      res.status(403).json({ error: 'Permission denied' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Serve binary file content endpoint (for images, etc.)
app.get('/api/projects/:projectName/files/content', authenticateToken, async (req, res) => {
  try {
    const uid = req.user?.username || req.user?.id || 'anonymous';
    ensureUserRoot(uid);
    try {
      quotaGuard(uid);
    } catch (error) {
      return respondWithGuardError(res, error);
    }
    const { projectName } = req.params;
    const { path: filePath } = req.query;
    // console.log('🖼️ Binary file serve request:', projectName, filePath);
    // Using fs from import
    // Using mime from import
    // Security check - ensure the path is safe and absolute
    if (!filePath || !path.isAbsolute(filePath)) {
      return res.status(400).json({ error: 'Invalid file path' });
    }
    try {
      ensureShellRootExists();
      assertPathWithinShellRoot(filePath, 'File path');
    } catch (error) {
      return respondWithGuardError(res, error);
    }
    try {
      quotaGuard(uid);
    } catch (error) {
      return respondWithGuardError(res, error);
    }
    // Check if file exists
    try {
      await fsPromises.access(filePath);
    } catch (error) {
      return res.status(404).json({ error: 'File not found' });
    }
    // Get file extension and set appropriate content type
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);
    // Stream the file
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    fileStream.on('error', (error) => {
      // console.error('Error streaming file:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error reading file' });
      }
    });
  } catch (error) {
    // console.error('Error serving binary file:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Save file content endpoint
app.put('/api/projects/:projectName/file', authenticateToken, async (req, res) => {
  try {
    const uid = req.user?.username || req.user?.id || 'anonymous';
    ensureUserRoot(uid);
    const { projectName } = req.params;
    const { filePath, content } = req.body;
    // console.log('💾 File save request:', projectName, filePath);
    // Using fsPromises from import
    // Security check - ensure the path is safe and absolute
    if (!filePath || !path.isAbsolute(filePath)) {
      return res.status(400).json({ error: 'Invalid file path' });
    }
    try {
      ensureShellRootExists();
      assertPathWithinShellRoot(filePath, 'File path');
    } catch (error) {
      return respondWithGuardError(res, error);
    }
    if (content === undefined) {
      return res.status(400).json({ error: 'Content is required' });
    }
    try {
      quotaGuard(uid);
    } catch (error) {
      return respondWithGuardError(res, error);
    }
    // Create backup of original file
    try {
      const backupPath = filePath + '.backup.' + Date.now();
      await fsPromises.copyFile(filePath, backupPath);
      // console.log('📋 Created backup:', backupPath);
    } catch (backupError) {
      // console.warn('Could not create backup:', backupError.message);
    }
    // Write the new content
    await fsPromises.writeFile(filePath, content, 'utf8');
    res.json({
      success: true,
      path: filePath,
      message: 'File saved successfully'
    });
  } catch (error) {
    // console.error('Error saving file:', error);
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: 'File or directory not found' });
    } else if (error.code === 'EACCES') {
      res.status(403).json({ error: 'Permission denied' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

app.get('/api/projects/:projectName/files', authenticateToken, async (req, res) => {
  try {
    const uid = req.user?.username || req.user?.id || 'anonymous';
    ensureUserRoot(uid);
    try {
      quotaGuard(uid);
    } catch (error) {
      return respondWithGuardError(res, error);
    }
    // Using fsPromises from import
    // Use extractProjectDirectory to get the actual project path
    let actualPath;
    try {
      actualPath = await extractProjectDirectory(req.params.projectName, uid);
    } catch (error) {
      // console.error('Error extracting project directory:', error);
      // Fallback to simple dash replacement
      actualPath = req.params.projectName.replace(/-/g, '/');
    }
    try {
      ensureShellRootExists();
      assertPathWithinShellRoot(actualPath, 'Project path');
    } catch (error) {
      return respondWithGuardError(res, error);
    }
    // Check if path exists
    try {
      await fsPromises.access(actualPath);
    } catch (e) {
      return res.status(404).json({ error: `Project path not found: ${actualPath}` });
    }

    const files = await getFileTree(actualPath, 3, 0, true);
    const hiddenFiles = files.filter(f => f.name.startsWith('.'));
    res.json(files);
  } catch (error) {
    // console.error('❌ File tree error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// WebSocket connection handler that routes based on URL path
wss.on('connection', (ws, request) => {
  const {url} = request;
  // console.log('🔗 Client connected to:', url);
  // Parse URL to get pathname without query parameters
  const urlObj = new URL(url, 'http://localhost');
  const {pathname} = urlObj;

  if (pathname === '/shell') {
    handleShellConnection(ws);
  } else if (pathname === '/ws') {
    handleChatConnection(ws, request);
  } else {
    // console.log('❌ Unknown WebSocket path:', pathname);
    ws.close();
  }
});

// Handle chat WebSocket connections
function handleChatConnection(ws, request) {
  // console.log('💬 Chat WebSocket connected');
  // Add to connected clients for project updates
  connectedClients.add(ws);
  const wsUser = request.user || null;

  // Extract cookies for Photon charging
  function parseCookies(cookieHeader) {
    const cookies = {};
    (cookieHeader || '').split(';').forEach(pair => {
      const [k, v] = pair.split('=').map(s => s && s.trim());
      if (k && v !== undefined) cookies[k] = decodeURIComponent(v);
    });
    return cookies;
  }

  const cookies = parseCookies(request.headers.cookie || '');
  const accessKey = cookies.appAccessKey;
  const clientName = cookies.clientName;
  const skuId = process.env.PHOTON_SKU_ID || 'your-app-sku-id'; // Set your app's Photon SKU ID

  // Initialize heartbeat for connection monitoring
  ws.isAlive = true;
  ws.on('pong', heartbeat);
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'gemini-command') {
        // console.log('💬 User message:', data.command || '[Continue/Resume]');
        // console.log('📁 Project:', data.options?.projectPath || 'Unknown');
        // console.log('🔄 Session:', data.options?.sessionId ? 'Resume' : 'New');
        await spawnGemini(data.command, {
          ...data.options,
          accessKey,
          clientName,
          skuId,
          user: wsUser,
        }, ws);
      } else if (data.type === 'abort-session') {
        // console.log('🛑 Abort session request:', data.sessionId);
        const success = abortGeminiSession(data.sessionId);
        ws.send(JSON.stringify({
          type: 'session-aborted',
          sessionId: data.sessionId,
          success
        }));
      }
    } catch (error) {
      // console.error('❌ Chat WebSocket error:', error.message);
      ws.send(JSON.stringify({
        type: 'error',
        error: error.message
      }));
    }
  });
  ws.on('close', () => {
    // console.log('🔌 Chat client disconnected');
    // Remove from connected clients
    connectedClients.delete(ws);
  });
}

// Handle shell WebSocket connections
function handleShellConnection(ws) {
  // console.log('🐚 Shell client connected');
  let shellProcess = null;
  let currentShellCwd = null;
  let inputBuffer = '';

  // Heartbeat to keep connection alive under server ping
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  const shellRoot = getShellRoot();

  const resolveWithinRoot = (targetPath) => {
    const resolved = path.resolve(currentShellCwd || shellRoot || process.cwd(), targetPath);
    return resolved;
  };

  const isPathAllowed = (targetPath) => {
    try {
      assertPathWithinShellRoot(targetPath, 'Shell path');
      return true;
    } catch {
      return false;
    }
  };

  const validateCommand = (command) => {
    if (!shellRoot) return { allowed: true };
    const trimmed = command.trim();
    if (!trimmed) return { allowed: true };

    // Basic parsing: split by whitespace while respecting simple quotes
    const tokens = trimmed.match(/(?:[^\s"']+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')+/g) || [];
    if (tokens.length === 0) return { allowed: true };

    // Handle explicit cd commands to keep cwd inside root
    if (tokens[0] === 'cd') {
      const target = tokens[1] || shellRoot;
      // Disallow cd -
      if (target === '-') {
        return { allowed: false, message: `cd - is not allowed under SHELL_ROOT (${shellRoot})` };
      }
      const resolved = path.isAbsolute(target) ? path.resolve(target) : resolveWithinRoot(target);
      if (!isPathWithinShellRoot(resolved)) {
        return { allowed: false, message: `Path not allowed. Stay within SHELL_ROOT (${shellRoot})` };
      }
      return { allowed: true, nextCwd: resolved };
    }

    // For other commands, block obvious absolute paths outside root
    for (const token of tokens) {
      // Skip flags
      if (token.startsWith('-')) continue;
      // Strip quotes
      const clean = token.replace(/^['"]|['"]$/g, '');
      if (path.isAbsolute(clean)) {
        if (!isPathWithinShellRoot(clean)) {
          return { allowed: false, message: `Access outside SHELL_ROOT is blocked (${shellRoot})` };
        }
      } else if (clean.includes('..') || clean.includes('/')) {
        const resolved = resolveWithinRoot(clean);
        if (!isPathWithinShellRoot(resolved)) {
          return { allowed: false, message: `Access outside SHELL_ROOT is blocked (${shellRoot})` };
        }
      }
    }

    return { allowed: true };
  };

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      // console.log('📨 Shell message received:', data.type);
      if (data.type === 'init') {
        // Initialize shell with project path and session info
        const shellRoot = getShellRoot();
        const projectPath = data.projectPath ? path.resolve(data.projectPath) : (shellRoot || process.cwd());
        try {
          ensureShellRootExists();
          assertPathWithinShellRoot(projectPath, 'Shell working directory');
        } catch (error) {
          ws.send(JSON.stringify({
            type: 'output',
            data: `\r\n\x1b[31m${error.message}\x1b[0m\r\n`
          }));
          return;
        }
        currentShellCwd = projectPath;
        // First send a welcome message
        const welcomeMsg = `\x1b[36mTerminal started in: ${projectPath}\x1b[0m\r\n`;
        ws.send(JSON.stringify({
          type: 'output',
          data: welcomeMsg
        }));
        try {
          // Start general-purpose shell using PTY for proper terminal emulation
          shellProcess = pty.spawn('bash', [], {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd: projectPath, // Start directly in project directory
            env: {
              ...process.env,
              TERM: 'xterm-256color',
              COLORTERM: 'truecolor',
              FORCE_COLOR: '3',
              // Override browser opening commands to echo URL for detection
              BROWSER: 'echo "OPEN_URL:"'
            }
          });
          // console.log('🟢 Shell process started with PTY, PID:', shellProcess.pid);
          // Handle data output
          shellProcess.onData((data) => {
            if (ws.readyState === ws.OPEN) {
              let outputData = data;
              // Check for various URL opening patterns
              const patterns = [
                // Direct browser opening commands
                /(?:xdg-open|open|start)\s+(https?:\/\/[^\s\x1b\x07]+)/g,
                // BROWSER environment variable override
                /OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g,
                // Git and other tools opening URLs
                /Opening\s+(https?:\/\/[^\s\x1b\x07]+)/gi,
                // General URL patterns that might be opened
                /Visit:\s*(https?:\/\/[^\s\x1b\x07]+)/gi,
                /View at:\s*(https?:\/\/[^\s\x1b\x07]+)/gi,
                /Browse to:\s*(https?:\/\/[^\s\x1b\x07]+)/gi
              ];
              patterns.forEach(pattern => {
                let match;
                while ((match = pattern.exec(data)) !== null) {
                  const url = match[1];
                  // console.log('🔗 Detected URL for opening:', url);
                  // Send URL opening message to client
                  ws.send(JSON.stringify({
                    type: 'url_open',
                    url: url
                  }));
                  // Replace the OPEN_URL pattern with a user-friendly message
                  if (pattern.source.includes('OPEN_URL')) {
                    outputData = outputData.replace(match[0], `🌐 Opening in browser: ${url}`);
                  }
                }
              });
              // Send regular output
              ws.send(JSON.stringify({
                type: 'output',
                data: outputData
              }));
            }
          });
          // Handle process exit
          shellProcess.onExit((exitCode) => {
            // console.log('🔚 Shell process exited with code:', exitCode.exitCode, 'signal:', exitCode.signal);
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({
                type: 'output',
                data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${exitCode.signal ? ` (${exitCode.signal})` : ''}\x1b[0m\r\n`
              }));
            }
            shellProcess = null;
          });
        } catch (spawnError) {
          // console.error('❌ Error spawning process:', spawnError);
          ws.send(JSON.stringify({
            type: 'output',
            data: `\r\n\x1b[31mError: ${spawnError.message}\x1b[0m\r\n`
          }));
        }
      } else if (data.type === 'input') {
        if (!shellProcess || !shellProcess.write) {
          return;
        }
        const payload = data.data;
        // If no root configured, passthrough
        if (!shellRoot) {
          try {
            shellProcess.write(payload);
          } catch (error) {
          }
          return;
        }

        for (let i = 0; i < payload.length; i++) {
          const ch = payload[i];
          if (ch === '\u0003') { // Ctrl+C
            inputBuffer = '';
            shellProcess.write(ch);
            continue;
          }
          if (ch === '\u0008' || ch === '\u007f') { // Backspace/Delete
            inputBuffer = inputBuffer.slice(0, -1);
            shellProcess.write(ch);
            continue;
          }
          if (ch === '\r' || ch === '\n') {
            const validation = validateCommand(inputBuffer);
            if (!validation.allowed) {
              ws.send(JSON.stringify({
                type: 'output',
                data: `\r\n\x1b[31m${validation.message}\x1b[0m\r\n`
              }));
              // Clear current line in the shell
              try {
                shellProcess.write('\u0015'); // Ctrl+U clears line in bash
              } catch {}
              inputBuffer = '';
              continue;
            }
            if (validation.nextCwd) {
              currentShellCwd = validation.nextCwd;
            }
            shellProcess.write(ch);
            inputBuffer = '';
            continue;
          }
          inputBuffer += ch;
          shellProcess.write(ch);
        }
      } else if (data.type === 'resize' && (shellProcess && shellProcess.resize)) {
                    shellProcess.resize(data.cols, data.rows);
              }
    } catch (error) {
      // console.error('❌ Shell WebSocket error:', error.message);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'output',
          data: `\r\n\x1b[31mError: ${error.message}\x1b[0m\r\n`
        }));
      }
    }
  });
  ws.on('close', () => {
    // console.log('🔌 Shell client disconnected');
    if (shellProcess && shellProcess.kill) {
      // console.log('🔴 Killing shell process:', shellProcess.pid);
      shellProcess.kill();
    }
  });
  ws.on('error', (error) => {
    // console.error('❌ Shell WebSocket error:', error);
  });
}

// Audio transcription endpoint
app.post('/api/transcribe', authenticateToken, async (req, res) => {
  try {
    const multer = (await import('multer')).default;
    const upload = multer({ storage: multer.memoryStorage() });
    // Handle multipart form data
    upload.single('audio')(req, res, async (err) => {
      if (err) {
        return res.status(400).json({ error: 'Failed to process audio file' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No audio file provided' });
      }
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: 'OpenAI API key not configured. Please set OPENAI_API_KEY in server environment.' });
      }
      try {
        // Create form data for OpenAI
        const FormData = (await import('form-data')).default;
        const formData = new FormData();
        formData.append('file', req.file.buffer, {
          filename: req.file.originalname,
          contentType: req.file.mimetype
        });
        formData.append('model', 'whisper-1');
        formData.append('response_format', 'json');
        formData.append('language', 'en');
        // Make request to OpenAI
        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            ...formData.getHeaders()
          },
          body: formData
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error?.message || `Whisper API error: ${response.status}`);
        }
        const data = await response.json();
        let transcribedText = data.text || '';
        // Check if enhancement mode is enabled
        const mode = req.body.mode || 'default';
        // If no transcribed text, return empty
        if (!transcribedText) {
          return res.json({ text: '' });
        }
        // If default mode, return transcribed text without enhancement
        if (mode === 'default') {
          return res.json({ text: transcribedText });
        }
        // Handle different enhancement modes
        try {
          const OpenAI = (await import('openai')).default;
          const openai = new OpenAI({ apiKey });
          let prompt, systemMessage, temperature = 0.7, maxTokens = 800;
          switch (mode) {
            case 'prompt':
              systemMessage = 'You are an expert prompt engineer who creates clear, detailed, and effective prompts.';
              prompt = `You are an expert prompt engineer. Transform the following rough instruction into a clear, detailed, and context-aware AI prompt.

Your enhanced prompt should:
1. Be specific and unambiguous
2. Include relevant context and constraints
3. Specify the desired output format
4. Use clear, actionable language
5. Include examples where helpful
6. Consider edge cases and potential ambiguities

Transform this rough instruction into a well-crafted prompt:
"${transcribedText}"

Enhanced prompt:`;
              break;

            case 'vibe':
            case 'instructions':
            case 'architect':
              systemMessage = 'You are a helpful assistant that formats ideas into clear, actionable instructions for AI agents.';
              temperature = 0.5; // Lower temperature for more controlled output
              prompt = `Transform the following idea into clear, well-structured instructions that an AI agent can easily understand and execute.

IMPORTANT RULES:
- Format as clear, step-by-step instructions
- Add reasonable implementation details based on common patterns
- Only include details directly related to what was asked
- Do NOT add features or functionality not mentioned
- Keep the original intent and scope intact
- Use clear, actionable language an agent can follow

Transform this idea into agent-friendly instructions:
"${transcribedText}"

Agent instructions:`;
              break;
            default:
              // No enhancement needed
              break;
          }
          // Only make GPT call if we have a prompt
          if (prompt) {
            const completion = await openai.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [
                { role: 'system', content: systemMessage },
                { role: 'user', content: prompt }
              ],
              temperature: temperature,
              max_tokens: maxTokens
            });
            transcribedText = completion.choices[0].message.content || transcribedText;
          }
        } catch (gptError) {
          // console.error('GPT processing error:', gptError);
          // Fall back to original transcription if GPT fails
        }
        res.json({ text: transcribedText });
      } catch (error) {
        // console.error('Transcription error:', error);
        res.status(500).json({ error: error.message });
      }
    });
  } catch (error) {
    // console.error('Endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Image upload endpoint
app.post('/api/projects/:projectName/upload-images', authenticateToken, async (req, res) => {
  try {
    const multer = (await import('multer')).default;
    const path = (await import('path')).default;
    const fs = (await import('fs')).promises;
    const os = (await import('os')).default;
    // Configure multer for image uploads
    const storage = multer.diskStorage({
      destination: async (req, file, cb) => {
        const uploadDir = path.join(os.tmpdir(), 'gemini-ui-uploads', String(req.user.id));
        await fs.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, uniqueSuffix + '-' + sanitizedName);
      }
    });
    const fileFilter = (req, file, cb) => {
      const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
      if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.'));
      }
    };

    const upload = multer({
      storage,
      fileFilter,
      limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
        files: 5
      }
    });

    // Handle multipart form data
    upload.array('images', 5)(req, res, async (err) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No image files provided' });
      }
      try {
        // Process uploaded images
        const processedImages = await Promise.all(
          req.files.map(async (file) => {
            // Read file and convert to base64
            const buffer = await fs.readFile(file.path);
            const base64 = buffer.toString('base64');
            const mimeType = file.mimetype;
            // Clean up temp file immediately
            await fs.unlink(file.path);
            return {
              name: file.originalname,
              data: `data:${mimeType};base64,${base64}`,
              size: file.size,
              mimeType: mimeType
            };
          })
        );
        res.json({ images: processedImages });
      } catch (error) {
        // console.error('Error processing images:', error);
        // Clean up any remaining files
        await Promise.all(req.files.map(f => fs.unlink(f.path).catch(() => {})));
        res.status(500).json({ error: 'Failed to process images' });
      }
    });
  } catch (error) {
    // console.error('Error in image upload endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve React app for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// Helper function to convert permissions to rwx format
function permToRwx(perm) {
  const r = perm & 4 ? 'r' : '-';
  const w = perm & 2 ? 'w' : '-';
  const x = perm & 1 ? 'x' : '-';
  return r + w + x;
}

async function getFileTree(dirPath, maxDepth = 3, currentDepth = 0, showHidden = true) {
  // Using fsPromises from import
  const items = [];
  try {
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      // Debug: log all entries including hidden files
      // Skip only heavy build directories
      if (entry.name === 'node_modules' ||
                entry.name === 'dist' ||
                entry.name === 'build') {
        continue;
      }
      const itemPath = path.join(dirPath, entry.name);
      const item = {
        name: entry.name,
        path: itemPath,
        type: entry.isDirectory() ? 'directory' : 'file'
      };
      // Get file stats for additional metadata
      try {
        const stats = await fsPromises.stat(itemPath);
        item.size = stats.size;
        item.modified = stats.mtime.toISOString();
        // Convert permissions to rwx format
        const {mode} = stats;
        const ownerPerm = (mode >> 6) & 7;
        const groupPerm = (mode >> 3) & 7;
        const otherPerm = mode & 7;
        item.permissions = ((mode >> 6) & 7).toString() + ((mode >> 3) & 7).toString() + (mode & 7).toString();
        item.permissionsRwx = permToRwx(ownerPerm) + permToRwx(groupPerm) + permToRwx(otherPerm);
      } catch (statError) {
        // If stat fails, provide default values
        item.size = 0;
        item.modified = null;
        item.permissions = '000';
        item.permissionsRwx = '---------';
      }
      if (entry.isDirectory() && currentDepth < maxDepth) {
        // Recursively get subdirectories but limit depth
        try {
          // Check if we can access the directory before trying to read it
          await fsPromises.access(item.path, fs.constants.R_OK);
          item.children = await getFileTree(item.path, maxDepth, currentDepth + 1, showHidden);
        } catch (e) {
          // Silently skip directories we can't access (permission denied, etc.)
          item.children = [];
        }
      }
      items.push(item);
    }
  } catch (error) {
    // Only log non-permission errors to avoid spam
    if (error.code !== 'EACCES' && error.code !== 'EPERM') {
      // console.error('Error reading directory:', error);
    }
  }
  return items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

const PORT = process.env.PORT || 4008;

// Initialize database and start server
async function startServer() {
  try {
    // Initialize authentication database
    await initializeDatabase();
    logPhotonConfig();
    // console.log('✅ Database initialization skipped (testing)');
    server.listen(PORT, '0.0.0.0', async () => {
      // console.log(`Gemini CLI UI server running on http://0.0.0.0:${PORT}`);
      // Start watching the projects folder for changes
      await setupProjectsWatcher(); // Re-enabled with better-sqlite3
    });
  } catch (error) {
    // console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
