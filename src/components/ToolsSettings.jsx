import { useState, useEffect } from 'react';
import { Button } from './ui/button';
import { X, Settings, Moon, Sun, Terminal, Zap } from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';

function ToolsSettings({ isOpen, onClose }) {
  const { isDarkMode, toggleDarkMode } = useTheme();
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const [projectSortOrder, setProjectSortOrder] = useState('name');

  // MCP server management state
  const [mcpServers, setMcpServers] = useState([]);
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [editingMcpServer, setEditingMcpServer] = useState(null);
  const [mcpFormData, setMcpFormData] = useState({
    name: '',
    type: 'stdio',
    scope: 'user', // Always use user scope
    config: {
      command: '',
      args: [],
      env: {},
      url: '',
      headers: {},
      timeout: 30000
    }
  });
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpTestResults, setMcpTestResults] = useState({});
  const [mcpConfigTestResult, setMcpConfigTestResult] = useState(null);
  const [mcpConfigTesting, setMcpConfigTesting] = useState(false);
  const [mcpConfigTested, setMcpConfigTested] = useState(false);
  const [mcpServerTools, setMcpServerTools] = useState({});
  const [mcpToolsLoading, setMcpToolsLoading] = useState({});
  const [selectedModel, setSelectedModel] = useState('gpt-5');

  // Available Gemini models (tested and verified)
  const availableModels = [
    { value: 'gpt-5', label: 'GPT-5', description: 'Current default model' }
  ];

  // MCP API functions
  const fetchMcpServers = async () => {
    try {
      // MCP endpoints are not implemented yet - skip these calls
      return;
      
      const token = localStorage.getItem('auth-token');
      
      // First try to get servers using Gemini CLI
      const cliResponse = await fetch('/api/mcp/cli/list', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (cliResponse.ok) {
        const cliData = await cliResponse.json();
        if (cliData.success && cliData.servers) {
          // Convert CLI format to our format
          const servers = cliData.servers.map(server => ({
            id: server.name,
            name: server.name,
            type: server.type,
            scope: 'user',
            config: {
              command: server.command || '',
              args: server.args || [],
              env: server.env || {},
              url: server.url || '',
              headers: server.headers || {},
              timeout: 30000
            },
            created: new Date().toISOString(),
            updated: new Date().toISOString()
          }));
          setMcpServers(servers);
          return;
        }
      }
      
      // Fallback to direct config reading
      const response = await fetch('/api/mcp/servers?scope=user', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        setMcpServers(data.servers || []);
      } else {
        // console.error('Failed to fetch MCP servers');
      }
    } catch (error) {
      // console.error('Error fetching MCP servers:', error);
    }
  };

  const saveMcpServer = async (serverData) => {
    try {
      const token = localStorage.getItem('auth-token');
      
      if (editingMcpServer) {
        // For editing, remove old server and add new one
        await deleteMcpServer(editingMcpServer.id, 'user');
      }
      
      // Use Gemini CLI to add the server
      const response = await fetch('/api/mcp/cli/add', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: serverData.name,
          type: serverData.type,
          command: serverData.config?.command,
          args: serverData.config?.args || [],
          url: serverData.config?.url,
          headers: serverData.config?.headers || {},
          env: serverData.config?.env || {}
        })
      });
      
      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          await fetchMcpServers(); // Refresh the list
          return true;
        } else {
          throw new Error(result.error || 'Failed to save server via Gemini CLI');
        }
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save server');
      }
    } catch (error) {
      // console.error('Error saving MCP server:', error);
      throw error;
    }
  };

  const deleteMcpServer = async (serverId, scope = 'user') => {
    try {
      const token = localStorage.getItem('auth-token');
      
      // Use Gemini CLI to remove the server
      const response = await fetch(`/api/mcp/cli/remove/${serverId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          await fetchMcpServers(); // Refresh the list
          return true;
        } else {
          throw new Error(result.error || 'Failed to delete server via Gemini CLI');
        }
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete server');
      }
    } catch (error) {
      // console.error('Error deleting MCP server:', error);
      throw error;
    }
  };

  const testMcpServer = async (serverId, scope = 'user') => {
    try {
      const token = localStorage.getItem('auth-token');
      const response = await fetch(`/api/mcp/servers/${serverId}/test?scope=${scope}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        return data.testResult;
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to test server');
      }
    } catch (error) {
      // console.error('Error testing MCP server:', error);
      throw error;
    }
  };

  const testMcpConfiguration = async (formData) => {
    try {
      const token = localStorage.getItem('auth-token');
      const response = await fetch('/api/mcp/servers/test', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(formData)
      });
      
      if (response.ok) {
        const data = await response.json();
        return data.testResult;
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to test configuration');
      }
    } catch (error) {
      // console.error('Error testing MCP configuration:', error);
      throw error;
    }
  };

  const discoverMcpTools = async (serverId, scope = 'user') => {
    try {
      const token = localStorage.getItem('auth-token');
      const response = await fetch(`/api/mcp/servers/${serverId}/tools?scope=${scope}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        return data.toolsResult;
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to discover tools');
      }
    } catch (error) {
      // console.error('Error discovering MCP tools:', error);
      throw error;
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadSettings();
    }
  }, [isOpen]);

  const loadSettings = async () => {
    try {
      
      // Load from localStorage
      const savedSettings = localStorage.getItem('gemini-tools-settings');
      
      if (savedSettings) {
        const settings = JSON.parse(savedSettings);
        setProjectSortOrder(settings.projectSortOrder || 'name');
        const storedModel = settings.selectedModel;
        const validModel = availableModels.some(m => m.value === storedModel) ? storedModel : 'gpt-5';
        setSelectedModel(validModel);
      } else {
        // Set defaults
        setProjectSortOrder('name');
      }

      // Load MCP servers from API
      await fetchMcpServers();
    } catch (error) {
      // console.error('Error loading tool settings:', error);
      // Set defaults on error
      setProjectSortOrder('name');
    }
  };

  const saveSettings = () => {
    setIsSaving(true);
    setSaveStatus(null);
    
    try {
      const settings = {
        projectSortOrder,
        selectedModel,
        lastUpdated: new Date().toISOString()
      };
      
      
      // Save to localStorage
      localStorage.setItem('gemini-tools-settings', JSON.stringify(settings));
      
      // Trigger storage event for current window
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'gemini-tools-settings',
        newValue: JSON.stringify(settings),
        oldValue: localStorage.getItem('gemini-tools-settings'),
        storageArea: localStorage,
        url: window.location.href
      }));
      
      setSaveStatus('success');
      
      setTimeout(() => {
        onClose();
      }, 1000);
    } catch (error) {
      // console.error('Error saving tool settings:', error);
      setSaveStatus('error');
    } finally {
      setIsSaving(false);
    }
  };

  // MCP form handling functions
  const resetMcpForm = () => {
    setMcpFormData({
      name: '',
      type: 'stdio',
      scope: 'user', // Always use user scope
      config: {
        command: '',
        args: [],
        env: {},
        url: '',
        headers: {},
        timeout: 30000
      }
    });
    setEditingMcpServer(null);
    setShowMcpForm(false);
    setMcpConfigTestResult(null);
    setMcpConfigTested(false);
    setMcpConfigTesting(false);
  };

  const openMcpForm = (server = null) => {
    if (server) {
      setEditingMcpServer(server);
      setMcpFormData({
        name: server.name,
        type: server.type,
        scope: server.scope,
        config: { ...server.config }
      });
    } else {
      resetMcpForm();
    }
    setShowMcpForm(true);
  };

  const handleMcpSubmit = async (e) => {
    e.preventDefault();
    
    setMcpLoading(true);
    
    try {
      await saveMcpServer(mcpFormData);
      resetMcpForm();
      setSaveStatus('success');
    } catch (error) {
      alert(`Error: ${error.message}`);
      setSaveStatus('error');
    } finally {
      setMcpLoading(false);
    }
  };

  const handleMcpDelete = async (serverId, scope) => {
    if (confirm('Are you sure you want to delete this MCP server?')) {
      try {
        await deleteMcpServer(serverId, scope);
        setSaveStatus('success');
      } catch (error) {
        alert(`Error: ${error.message}`);
        setSaveStatus('error');
      }
    }
  };

  const handleMcpTest = async (serverId, scope) => {
    try {
      setMcpTestResults({ ...mcpTestResults, [serverId]: { loading: true } });
      const result = await testMcpServer(serverId, scope);
      setMcpTestResults({ ...mcpTestResults, [serverId]: result });
    } catch (error) {
      setMcpTestResults({ 
        ...mcpTestResults, 
        [serverId]: { 
          success: false, 
          message: error.message,
          details: []
        } 
      });
    }
  };

  const handleMcpToolsDiscovery = async (serverId, scope) => {
    try {
      setMcpToolsLoading({ ...mcpToolsLoading, [serverId]: true });
      const result = await discoverMcpTools(serverId, scope);
      setMcpServerTools({ ...mcpServerTools, [serverId]: result });
    } catch (error) {
      setMcpServerTools({ 
        ...mcpServerTools, 
        [serverId]: { 
          success: false, 
          tools: [], 
          resources: [], 
          prompts: [] 
        } 
      });
    } finally {
      setMcpToolsLoading({ ...mcpToolsLoading, [serverId]: false });
    }
  };

  const updateMcpConfig = (key, value) => {
    setMcpFormData(prev => ({
      ...prev,
      config: {
        ...prev.config,
        [key]: value
      }
    }));
    // Reset test status when configuration changes
    setMcpConfigTestResult(null);
    setMcpConfigTested(false);
  };

  const handleTestConfiguration = async () => {
    setMcpConfigTesting(true);
    try {
      const result = await testMcpConfiguration(mcpFormData);
      setMcpConfigTestResult(result);
      setMcpConfigTested(true);
    } catch (error) {
      setMcpConfigTestResult({
        success: false,
        message: error.message,
        details: []
      });
      setMcpConfigTested(true);
    } finally {
      setMcpConfigTesting(false);
    }
  };

  const getTransportIcon = (type) => {
    switch (type) {
      case 'stdio': return <Terminal className="w-4 h-4" />;
      case 'sse': return <Zap className="w-4 h-4" />;
      case 'http': return <Globe className="w-4 h-4" />;
      default: return <Server className="w-4 h-4" />;
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="modal-backdrop fixed inset-0 flex items-center justify-center z-[100] md:p-4 bg-background/95 glass-morphism">
      <div className="bg-background border border-border md:rounded-lg shadow-elevated w-full md:max-w-4xl h-full md:h-[90vh] flex flex-col glass-morphism dark:glass-morphism-dark">
        <div className="flex items-center justify-between p-4 md:p-6 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-3">
            <Settings className="w-5 h-5 md:w-6 md:h-6 text-gemini-500" />
            <h2 className="text-lg md:text-xl font-semibold text-foreground">
              Settings
            </h2>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground touch-manipulation"
          >
            <X className="w-5 h-5" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="p-4 md:p-6 space-y-6 md:space-y-8 pb-safe-area-inset-bottom">
            <div className="space-y-6 md:space-y-8">

            {/* Model Selection */}
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Zap className="w-5 h-5 text-cyan-500" />
                <h3 className="text-lg font-medium text-foreground">
                  Model
                </h3>
              </div>
              <div className="bg-cyan-50 dark:bg-cyan-900/20 border border-cyan-200 dark:border-cyan-800 rounded-lg p-4">
                <div className="space-y-3">
                  <label className="block text-sm font-medium text-foreground">
                    Select Model
                  </label>
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg focus:ring-cyan-500 focus:border-cyan-500"
                  >
                    {availableModels.map(model => (
                      <option key={model.value} value={model.value}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                  <div className="text-sm text-gray-600 dark:text-gray-400">
                    {availableModels.find(m => m.value === selectedModel)?.description}
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      More models will be available soon.
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Appearance */}
            <div className="space-y-6 md:space-y-8">
              {/* Theme Settings */}
              <div className="space-y-4">
                <div className="bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 neumorphic dark:neumorphic-dark">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-foreground">
                        Dark Mode
                      </div>
                      <div className="text-sm text-muted-foreground">
                        Toggle between light and dark themes
                      </div>
                    </div>
                    <button
                      onClick={toggleDarkMode}
                      className="relative inline-flex h-8 w-14 items-center rounded-full bg-zinc-200 dark:bg-zinc-700 transition-all duration-300 focus:outline-hidden focus:ring-2 focus:ring-gemini-500 focus:ring-offset-2 dark:focus:ring-offset-zinc-900 morph-hover"
                      role="switch"
                      aria-checked={isDarkMode}
                      aria-label="Toggle dark mode"
                    >
                      <span className="sr-only">Toggle dark mode</span>
                      <span
                        className={`${
                          isDarkMode ? 'translate-x-7' : 'translate-x-1'
                        } inline-block h-6 w-6 transform rounded-full bg-white shadow-lg transition-transform duration-200 items-center justify-center`}
                      >
                        {isDarkMode ? (
                          <Moon className="w-3.5 h-3.5 text-zinc-700" />
                        ) : (
                          <Sun className="w-3.5 h-3.5 text-yellow-500" />
                        )}
                      </span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Project Sorting */}
              <div className="space-y-4">
                <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-foreground">
                        Project Sorting
                      </div>
                      <div className="text-sm text-muted-foreground">
                        How projects are ordered in the sidebar
                      </div>
                    </div>
                    <select
                      value={projectSortOrder}
                      onChange={(e) => setProjectSortOrder(e.target.value)}
                      className="text-sm bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 rounded-lg focus:ring-gemini-500 focus:border-gemini-500 p-2 w-32"
                    >
                      <option value="name">Alphabetical</option>
                      <option value="date">Recent Activity</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>

            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-4 md:p-6 border-t border-border flex-shrink-0 gap-3 pb-safe-area-inset-bottom">
          <div className="flex items-center justify-center sm:justify-start gap-2 order-2 sm:order-1">
            {saveStatus === 'success' && (
              <div className="text-green-600 dark:text-green-400 text-sm flex items-center gap-1">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Settings saved successfully!
              </div>
            )}
            {saveStatus === 'error' && (
              <div className="text-red-600 dark:text-red-400 text-sm flex items-center gap-1">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                Failed to save settings
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 order-1 sm:order-2">
            <Button 
              variant="outline" 
              onClick={onClose} 
              disabled={isSaving}
              className="flex-1 sm:flex-none h-10 touch-manipulation text-foreground"
            >
              Cancel
            </Button>
            <Button 
              onClick={saveSettings} 
              disabled={isSaving}
              className="flex-1 sm:flex-none h-10 bg-gemini-500 hover:bg-gemini-600 disabled:opacity-50 touch-manipulation"
            >
              {isSaving ? (
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Saving...
                </div>
              ) : (
                'Save Settings'
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ToolsSettings;
