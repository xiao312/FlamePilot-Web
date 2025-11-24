import jwt from 'jsonwebtoken';
import { userDb } from '../database/db.js';

// Get JWT secret from environment or use default (for development)
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-here';

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }

  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  console.log('authenticateToken called for', req.path);
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    console.log('No token provided');
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    console.log('Verifying token');
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log('Token decoded:', decoded);

    // Verify user still exists and is active
    console.log('Getting user by id:', decoded.userId);
    const user = userDb.getUserById(decoded.userId);
    console.log('User found:', !!user);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token. User not found.' });
    }

    req.user = user;
    console.log('Authentication successful');
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// Generate JWT token (never expires)
const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username
    },
    JWT_SECRET
    // No expiration - token lasts forever
  );
};

// WebSocket authentication function
const authenticateWebSocket = (token) => {
  if (!token) {
    return null;
  }

  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    console.error('WebSocket token verification error:', error);
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  generateToken,
  authenticateWebSocket,
  JWT_SECRET
};