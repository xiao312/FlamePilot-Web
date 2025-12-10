import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../utils/api';

const AuthContext = createContext({
  user: null,
  token: null,
  login: () => {},
  register: () => {},
  logout: () => {},
  isLoading: true,
  needsSetup: false,
  error: null
});

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('auth-token'));
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [error, setError] = useState(null);
  const [isBohriumMode, setIsBohriumMode] = useState(false);

  // Check authentication status on mount
  useEffect(() => {
    checkAuthStatus();
  }, []);

  const parseBohriumUser = () => {
    try {
      const raw = localStorage.getItem('user-info');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.userNo) return null;
      const uid = String(parsed.userNo);
      const name = parsed.userName || parsed.userNameEn || uid;
      const email = parsed.email || parsed.gitLoginName || '';
      console.info('[Auth] Bohrium user detected', { uid, name, email: Boolean(email) });
      return { uid, name, email };
    } catch (err) {
      console.error('Failed to parse Bohrium user-info:', err);
      return null;
    }
  };

  const parseDevIdentity = () => {
    const cookieMap = document.cookie.split(';').reduce((acc, pair) => {
      const [k, ...rest] = pair.trim().split('=');
      if (k) acc[k] = rest.join('=');
      return acc;
    }, {});
    const devKey = cookieMap.DEV_ACCESS_KEY || (typeof __DEV_ACCESS_KEY__ !== 'undefined' ? __DEV_ACCESS_KEY__ : '');
    if (!devKey) return null;
    return { uid: String(devKey), name: 'Dev User', email: '' };
  };

  const tryAutoAuth = async () => {
    const identity = parseBohriumUser() || parseDevIdentity();
    if (!identity) return false;

    try {
      const response = await api.auth.bohriumLogin(identity);
      const data = await response.json();
      if (response.ok && data.token) {
        setToken(data.token);
        setUser(data.user);
        setNeedsSetup(false);
        setIsBohriumMode(true);
        localStorage.setItem('auth-token', data.token);
        console.info('[Auth] Bohrium bootstrap succeeded', { uid: identity.uid });
        return true;
      }
      console.warn('[Auth] Bohrium bootstrap failed', { status: response.status, uid: identity.uid, message: data?.error });
      return false;
    } catch (err) {
      console.error('Bohrium auth failed:', err);
      return false;
    }
  };

  const checkAuthStatus = async () => {
    try {
      setIsLoading(true);
      setError(null);
      // Attempt Bohrium bootstrap first (if available)
      const bohrAuthenticated = await tryAutoAuth();
      if (bohrAuthenticated) {
        setIsLoading(false);
        return;
      }
      // Check if system needs setup (returns false in Bohrium mode)
      const statusResponse = await api.auth.status();
      const statusData = await statusResponse.json();
      if (statusData.needsSetup) {
        setNeedsSetup(true);
        setIsLoading(false);
        return;
      }
      // If we have a token, verify it
      if (token) {
        try {
          const userResponse = await api.auth.user();
          if (userResponse.ok) {
            const userData = await userResponse.json();
            setUser(userData.user);
            setNeedsSetup(false);
          } else {
            // Token is invalid
            localStorage.removeItem('auth-token');
            setToken(null);
            setUser(null);
          }
        } catch (error) {
          console.error('Token verification failed:', error);
          localStorage.removeItem('auth-token');
          setToken(null);
          setUser(null);
        }
      }
    } catch (error) {
      console.error('Auth status check failed:', error);
      setError('Failed to check authentication status');
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (username, password) => {
    try {
      setError(null);
      const response = await api.auth.login(username, password);
      const data = await response.json();
      if (response.ok) {
        setToken(data.token);
        setUser(data.user);
        localStorage.setItem('auth-token', data.token);
        return { success: true };
      } else {
        setError(data.error || 'Login failed');
        return { success: false, error: data.error || 'Login failed' };
      }
    } catch (error) {
      console.error('Login error:', error);
      const errorMessage = 'Network error. Please try again.';
      setError(errorMessage);
      return { success: false, error: errorMessage };
    }
  };

  const register = async (username, password) => {
    try {
      setError(null);
      const response = await api.auth.register(username, password);
      const data = await response.json();
      if (response.ok) {
        setToken(data.token);
        setUser(data.user);
        setNeedsSetup(false);
        localStorage.setItem('auth-token', data.token);
        return { success: true };
      } else {
        setError(data.error || 'Registration failed');
        return { success: false, error: data.error || 'Registration failed' };
      }
    } catch (error) {
      console.error('Registration error:', error);
      const errorMessage = 'Network error. Please try again.';
      setError(errorMessage);
      return { success: false, error: errorMessage };
    }
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem('auth-token');

    // Optional: Call logout endpoint for logging
    if (token) {
      api.auth.logout().catch(error => {
        console.error('Logout endpoint error:', error);
      });
    }
  };

  const value = {
    user,
    token,
    login,
    register,
    logout,
    isLoading,
    needsSetup,
    error,
    isBohriumMode
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
