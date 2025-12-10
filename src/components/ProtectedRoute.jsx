import React from 'react';
import { useAuth } from '../contexts/AuthContext';
import { MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';

const LoadingScreen = () => (
  <div className="min-h-screen bg-background flex items-center justify-center p-4">
    <div className="text-center">
      <div className="flex justify-center mb-4">
        <div className="w-16 h-16 bg-primary rounded-lg flex items-center justify-center shadow-layered glow-sidebar">
          <MessageSquare className="w-8 h-8 text-primary-foreground" />
        </div>
      </div>
      <h1 className="text-2xl font-bold text-foreground mb-2">Gemini Code UI</h1>
      <div className="flex items-center justify-center space-x-2">
        <div className="w-2 h-2 bg-gemini-500 rounded-full animate-bounce"></div>
        <div className="w-2 h-2 bg-gemini-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
        <div className="w-2 h-2 bg-gemini-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
      </div>
      <p className="text-muted-foreground mt-2">Loading...</p>
    </div>
  </div>
);

const ProtectedRoute = ({ children }) => {
  const { user, isLoading, isBohriumMode } = useAuth();
  const [awaitingIdentity, setAwaitingIdentity] = useState(false);

  useEffect(() => {
    if (!isLoading && !user) {
      setAwaitingIdentity(true);
    } else {
      setAwaitingIdentity(false);
    }
  }, [isLoading, user]);

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="text-center space-y-3">
          <div className="flex justify-center">
            <div className="w-16 h-16 bg-primary rounded-lg flex items-center justify-center shadow-layered glow-sidebar">
              <MessageSquare className="w-8 h-8 text-primary-foreground" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-foreground">Waiting for identity</h1>
          <p className="text-muted-foreground">
            {awaitingIdentity ? 'Awaiting Bohrium/appAccessKey (or dev mock) to sign you in automatically.' : 'Initializing...'}
          </p>
          {!isBohriumMode && (
            <p className="text-xs text-muted-foreground">
              Ensure Bohrium injects user-info/localStorage or set VITE_DEV_USER_ID for local dev.
            </p>
          )}
        </div>
      </div>
    );
  }

  return children;
};

export default ProtectedRoute;
