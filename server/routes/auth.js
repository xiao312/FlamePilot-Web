import express from 'express';
import bcrypt from 'bcrypt';
import { userDb } from '../database/db.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';
import logger, { auditLogger } from '../logger.js';

const router = express.Router();

// Check auth status and setup requirements
router.get('/status', async (req, res) => {
  try {
    res.json({
      needsSetup: false,
      isAuthenticated: false // Will be overridden by frontend if token exists
    });
  } catch (error) {
    console.error('Auth status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Registration disabled in favor of upstream identity
router.post('/register', async (_req, res) => {
  return res.status(403).json({ error: 'Registration is disabled. Use Bohrium/appAccessKey authentication.' });
});

// User login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    // Validate input
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    // Get user from database
    const user = userDb.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    // Generate token
    const token = generateToken(user);
    // Update last login
    userDb.updateLastLogin(user.id);
    res.json({
      success: true,
      user: { id: user.id, username: user.username },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bohrium-provided identity bootstrap (passwordless)
router.post('/bohrium', async (req, res) => {
  try {
    const { uid, email, name } = req.body || {};
    const cleanedUid = (uid || '').toString().trim();

    if (!cleanedUid) {
      return res.status(400).json({ error: 'Missing user identifier' });
    }

    // Ensure a user record exists (username keyed by uid)
    const user = userDb.getOrCreateExternalUser(cleanedUid);
    userDb.updateLastLogin(user.id);

    logger.info('[Auth] Bohrium login', { action: 'bohrium_login', uid: cleanedUid, userId: user.id });
    auditLogger.info('bohrium_login', { uid: cleanedUid, userId: user.id, email, name });

    const token = generateToken(user);
    return res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email,
        name
      },
      token
    });
  } catch (error) {
    console.error('Bohrium auth error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user (protected route)
router.get('/user', authenticateToken, (req, res) => {
  res.json({
    user: req.user
  });
});

// Logout (client-side token removal, but this endpoint can be used for logging)
router.post('/logout', authenticateToken, (req, res) => {
  // In a simple JWT system, logout is mainly client-side
  // This endpoint exists for consistency and potential future logging
  res.json({ success: true, message: 'Logged out successfully' });
});

export default router;
