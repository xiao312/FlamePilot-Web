import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import sessionManager from './sessionManager.js';

let activeGeminiProcesses = new Map(); // Track active processes by session ID

function computePhotonCharge(totalTokens) {
  const basePerQuery = 3;
  const per1kTokens = 3;

  const tokenBlocks = Math.ceil((totalTokens || 0) / 1000);
  return basePerQuery + tokenBlocks * per1kTokens;
  // e.g. totalTokens = 6089 -> 3 + ceil(6.089)*3 = 3 + 6*3 = 21 photons
}

async function chargePhotons({ accessKey, clientName, skuId, eventValue }) {
  // Dev mode mocking: don't hit real API
  if (process.env.PHOTON_DEV_MODE === '1' && process.env.PHOTON_MOCK === '1') {
    console.log(`[DEV-MOCK] Would charge ${eventValue} photons (skuId=${skuId})`);
    return { statusCode: 200, body: { code: 0, mock: true } };
  }

  const url = 'https://openapi.dp.tech/openapi/v1/api/integral/consume';

  // bizNo: unique int per request (timestamp + random)
  const timestamp = Math.floor(Date.now() / 1000); // seconds
  const rand = Math.floor(Math.random() * 9000) + 1000; // 4-digit
  const bizNo = Number(`${timestamp}${rand}`);

  const headers = {
    'accessKey': accessKey,
    'x-app-key': clientName,       // corresponds to CLIENT_NAME
    'Content-Type': 'application/json',
    'Accept': '*/*',
  };

  const payload = {
    bizNo,
    changeType: 1,
    eventValue,                    // photon amount to deduct
    skuId,                         // each app has a unique skuId
    scene: 'appCustomizeCharge',
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    // timeout: 10_000, // fetch doesn't have timeout, maybe use AbortController
  });

  let data;
  try {
    data = await res.json();
  } catch {
    data = { rawText: await res.text() };
  }

  return { statusCode: res.status, body: data };
}

async function spawnGemini(command, options = {}, ws) {
   console.log('Spawning Gemini CLI for command:', command);
   return new Promise(async (resolve, reject) => {
     const { sessionId, projectPath, cwd, resume, toolsSettings, permissionMode, images } = options;
     let capturedSessionId = sessionId; // Track session ID throughout the process
     let sessionCreatedSent = false; // Track if we've already sent session-created event
     let assistantResponse = ''; // Accumulate assistant response from JSON
     let lastTokenCount = 0;   // Track last token usage
    
    // Process images if provided
    
    // Use tools settings passed from frontend, or defaults
    const settings = toolsSettings || {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false
    };
    
    // Use tools settings
    
    // Build Gemini CLI command - start with print/resume flags first
    const args = ['web',];
    console.log('Building Gemini CLI command with args:', args);
    
    // Add prompt flag with command if we have a command
    if (command && command.trim()) {
      // If we have a sessionId, include conversation history
      if (sessionId) {
        const context = sessionManager.buildConversationContext(sessionId);
        if (context) {
          // Combine context with current command
          const fullPrompt = context + command;
          args.push('-m', fullPrompt);
        } else {
          args.push('-m', command);
        }
      } else {
        args.push('-m', command);
      }
    }
    let promptToUse = (sessionId && sessionManager.buildConversationContext(sessionId)) ? (sessionManager.buildConversationContext(sessionId) + command) : command;
    promptToUse = promptToUse.replace(/\n/g, '\\n');
    
    // Use cwd (actual project directory) instead of projectPath (Gemini's metadata directory)
    // Debug - cwd and projectPath
    // Clean the path by removing any non-printable characters
    const cleanPath = (cwd || process.cwd()).replace(/[^\x20-\x7E]/g, '').replace(/>/g, '').trim();
    const workingDir = cleanPath;
    // Debug - workingDir
    
    // Handle images by saving them to temporary files and passing paths to Gemini
    const tempImagePaths = [];
    let tempDir = null;
    if (images && images.length > 0) {
      try {
        // Create temp directory in the project directory so Gemini can access it
        tempDir = path.join(workingDir, '.tmp', 'images', Date.now().toString());
        await fs.mkdir(tempDir, { recursive: true });
        
        // Save each image to a temp file
        for (const [index, image] of images.entries()) {
          // Extract base64 data and mime type
          const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
          if (!matches) {
            // console.error('Invalid image data format');
            continue;
          }
          
          const [, mimeType, base64Data] = matches;
          const extension = mimeType.split('/')[1] || 'png';
          const filename = `image_${index}.${extension}`;
          const filepath = path.join(tempDir, filename);
          
          // Write base64 data to file
          await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
          tempImagePaths.push(filepath);
        }
        
        // Include the full image paths in the prompt for Gemini to reference
        // Gemini CLI can read images from file paths in the prompt
        if (tempImagePaths.length > 0 && command && command.trim()) {
          const imageNote = `\n\n[Images attached: ${tempImagePaths.length} images available. Saved at the following paths:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
          const modifiedCommand = command + imageNote;
          
          // Update the command in args
          const promptIndex = args.indexOf('-m');
          if (promptIndex !== -1 && args[promptIndex + 1] === command) {
            args[promptIndex + 1] = modifiedCommand;
          } else if (promptIndex !== -1) {
            // If we're using context, update the full prompt
            args[promptIndex + 1] += imageNote;
          }
        }
        
        
      } catch (error) {
        // console.error('Error processing images for Gemini:', error);
      }
    }
    
    // Gemini doesn't support resume functionality
    // Skip resume handling
    
    // Add basic flags for Gemini
    // Only add debug flag if explicitly requested
    if (options.debug) {
      args.push('--debug');
    }
    
    // Add MCP config flag only if MCP servers are configured
    try {
      // Use already imported modules (fs.promises is imported as fs, path, os)
      const fsSync = await import('fs'); // Import synchronous fs methods
      
      // Check for MCP config in ~/.gemini.json
      const geminiConfigPath = path.join(os.homedir(), '.gemini.json');
      
      
      let hasMcpServers = false;
      
      // Check Gemini config for MCP servers
      if (fsSync.existsSync(geminiConfigPath)) {
        try {
          const geminiConfig = JSON.parse(fsSync.readFileSync(geminiConfigPath, 'utf8'));
          
          // Check global MCP servers
          if (geminiConfig.mcpServers && Object.keys(geminiConfig.mcpServers).length > 0) {
            hasMcpServers = true;
          }
          
          // Check project-specific MCP servers
          if (!hasMcpServers && geminiConfig.geminiProjects) {
            const currentProjectPath = process.cwd();
            const projectConfig = geminiConfig.geminiProjects[currentProjectPath];
            if (projectConfig && projectConfig.mcpServers && Object.keys(projectConfig.mcpServers).length > 0) {
              hasMcpServers = true;
            }
          }
        } catch (e) {
        }
      }
      
      
      if (hasMcpServers) {
        // Use Gemini config file if it has MCP servers
        let configPath = null;
        
        if (fsSync.existsSync(geminiConfigPath)) {
          try {
            const geminiConfig = JSON.parse(fsSync.readFileSync(geminiConfigPath, 'utf8'));
            
            // Check if we have any MCP servers (global or project-specific)
            const hasGlobalServers = geminiConfig.mcpServers && Object.keys(geminiConfig.mcpServers).length > 0;
            const currentProjectPath = process.cwd();
            const projectConfig = geminiConfig.geminiProjects && geminiConfig.geminiProjects[currentProjectPath];
            const hasProjectServers = projectConfig && projectConfig.mcpServers && Object.keys(projectConfig.mcpServers).length > 0;
            
            if (hasGlobalServers || hasProjectServers) {
              configPath = geminiConfigPath;
            }
          } catch (e) {
            // No valid config found
          }
        }
        
        if (configPath) {
          args.push('--mcp-config', configPath);
        } else {
        }
      }
    } catch (error) {
      // If there's any error checking for MCP configs, don't add the flag
      // MCP config check failed, proceeding without MCP support
    }
    
    // Add model for all sessions (both new and resumed)
    // Debug - Model from options and resume session
    const modelToUse = options.model || 'gemini-2.5-flash';
    // Debug - Using model
    // args.push('--model', modelToUse);
    
    // Add --yolo flag if skipPermissions is enabled
    if (settings.skipPermissions) {
      args.push('--yolo');
    } else {
    }
    
    // Gemini doesn't support these tool permission flags
    // Skip all tool settings
    
    // console.log('Spawning Gemini CLI with args:', args);
    console.log('Working directory:', workingDir);

    // Try to find gemini in PATH first, then fall back to environment variable
    const geminiPath = process.env.GEMINI_PATH || 'flame-pilot';
    // console.log('Full command:', geminiPath, args.join(' '));

    const fullCommand = `cd "${workingDir}" && ${geminiPath} web -m "${promptToUse}"`;
    console.log('Executing command:', fullCommand);
    const geminiProcess = spawn('bash', ['-c', fullCommand], {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env } // Inherit all environment variables
    });
    
    // Attach temp file info to process for cleanup later
    geminiProcess.tempImagePaths = tempImagePaths;
    geminiProcess.tempDir = tempDir;
    
    // Store process reference for potential abort
    const processKey = capturedSessionId || sessionId || Date.now().toString();
    activeGeminiProcesses.set(processKey, geminiProcess);
    // Debug - Stored Gemini process with key
    
    // Store sessionId on the process object for debugging
    geminiProcess.sessionId = processKey;
    
    // Close stdin to signal we're done sending input
    geminiProcess.stdin.end();
    
    // Timeout disabled
    // let hasReceivedOutput = false;
    // const timeoutMs = 120000; // 2 minutes
    // const timeout = setTimeout(() => {
    //   if (!hasReceivedOutput) {
    //     // console.error('⏰ Gemini CLI timeout - no output received after', timeoutMs, 'ms');
    //     ws.send(JSON.stringify({
    //       type: 'gemini-error',
    //       error: 'Gemini CLI timeout - no response received'
    //     }));
    //     geminiProcess.kill('SIGTERM');
    //   }
    // }, timeoutMs);
    
    // Save user message to session when starting
    if (command && capturedSessionId) {
      sessionManager.addMessage(capturedSessionId, 'user', command);
    }
    
    // Handle stdout (outputs JSON lines)
    
    geminiProcess.stdout.on('data', (data) => {
      const rawOutput = data.toString();
      console.log('Raw stdout:', rawOutput);
      // hasReceivedOutput = true;
      // clearTimeout(timeout);
      
      // Filter out debug messages and system messages
      const lines = rawOutput.split('\n');
      const filteredLines = lines.filter(line => {
        // Skip debug messages
        if (line.includes('[DEBUG]') ||
            line.includes('Flushing log events') ||
            line.includes('Clearcut response') ||
            line.includes('[MemoryDiscovery]') ||
            line.includes('[BfsFileSearch]')) {
          return false;
        }
        return true;
      });
      
      for (const line of filteredLines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line);
          if (parsed && typeof parsed === 'object' && parsed.type === 'cli-response') {
            // Send the structured data directly
            console.log('Sending to WebSocket:', parsed);
            ws.send(JSON.stringify(parsed));

            // Track last token usage if present
            const usage = parsed.data && parsed.data.usage;
            if (usage && typeof usage.total_token_count === 'number') {
              lastTokenCount = usage.total_token_count;
            }

            // Accumulate content for session saving
            if (parsed.data && parsed.data.message && parsed.data.message.content) {
              const content = parsed.data.message.content;
              if (Array.isArray(content)) {
                for (const part of content) {
                  if (part.type === 'text' && part.text) {
                    assistantResponse += part.text + '\n';
                  }
                }
              } else if (typeof content === 'string') {
                assistantResponse += content + '\n';
              }
            }
          }
            // Ignore non-matching JSON or non-JSON lines
          } catch (e) {
            // Not JSON, skip
          }
        }
      }
      
      // For new sessions, create a session ID
      if (!sessionId && !sessionCreatedSent && !capturedSessionId) {
        capturedSessionId = `gemini_${Date.now()}`;
        sessionCreatedSent = true;
        
        // Create session in session manager
        sessionManager.createSession(capturedSessionId, cwd || process.cwd());
        
        // Save the user message now that we have a session ID
        if (command) {
          sessionManager.addMessage(capturedSessionId, 'user', command);
        }
        
        // Update process key with captured session ID
        if (processKey !== capturedSessionId) {
          activeGeminiProcesses.delete(processKey);
          activeGeminiProcesses.set(capturedSessionId, geminiProcess);
        }
        
        ws.send(JSON.stringify({
          type: 'session-created',
          sessionId: capturedSessionId
        }));
      }
    });
    
    // Handle stderr
    geminiProcess.stderr.on('data', (data) => {
      const errorMsg = data.toString();
      console.log('Gemini stderr:', errorMsg);
      
      // Filter out deprecation warnings
      if (errorMsg.includes('[DEP0040]') ||
          errorMsg.includes('DeprecationWarning') ||
          errorMsg.includes('--trace-deprecation')) {
        // Log but don't send to client
        // Debug - Gemini CLI warning (suppressed)
        return;
      }
      
      // console.error('Gemini CLI stderr:', errorMsg);
      ws.send(JSON.stringify({
        type: 'gemini-error',
        error: errorMsg
      }));
    });

    // Handle process completion
    geminiProcess.on('close', async (code) => {
      console.log(`Gemini CLI process exited with code ${code}`);
      // clearTimeout(timeout);
      
      // Clean up process reference
      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeGeminiProcesses.delete(finalSessionId);
      
      // Save assistant response to session if we have one
      if (finalSessionId && assistantResponse.trim()) {
        sessionManager.addMessage(finalSessionId, 'assistant', assistantResponse.trim());
      }

      // --- Photon charging begins here ---
      try {
        // Dev mode: use env vars; Prod mode: use options from cookies
        const isDevMode = process.env.PHOTON_DEV_MODE === '1';
        const accessKey = isDevMode ? (options.accessKey || process.env.DEV_ACCESS_KEY) : options.accessKey;
        const clientName = isDevMode ? (options.clientName || process.env.CLIENT_NAME) : options.clientName;
        const skuId = isDevMode ? (options.skuId || Number(process.env.SKU_ID)) : options.skuId;

        if (accessKey && clientName && skuId && lastTokenCount >= 0) {
          const photons = computePhotonCharge(lastTokenCount);
          const chargeResult = await chargePhotons({
            accessKey,
            clientName,
            skuId,
            eventValue: photons,
          });

          // Notify frontend about the charge
          ws.send(JSON.stringify({
            type: 'photon-charge',
            data: {
              photonsCharged: photons,
              tokensUsed: lastTokenCount,
              price: {
                perQuery: 3,
                per1kTokens: 3,
              },
              chargeResponse: chargeResult.body, // { code: 0, ... } or error
            },
          }));
        } else {
          // If missing info, send a warning to frontend (but don't crash)
          ws.send(JSON.stringify({
            type: 'photon-charge',
            error: 'Missing accessKey/clientName/skuId; Photon not charged',
            tokensUsed: lastTokenCount,
          }));
        }
      } catch (err) {
        console.error('Photon charge failed:', err);
        ws.send(JSON.stringify({
          type: 'photon-charge',
          error: 'Photon charging failed',
          tokensUsed: lastTokenCount,
        }));
      }
      // --- Photon charging end ---

       console.log('WebSocket readyState:', ws.readyState);
       console.log('Sending gemini-complete:', { type: 'gemini-complete', exitCode: code, isNewSession: !sessionId && !!command });
       if (ws.readyState === 1) { // WebSocket.OPEN
         ws.send(JSON.stringify({
           type: 'gemini-complete',
           exitCode: code,
           isNewSession: !sessionId && !!command // Flag to indicate this was a new session
         }));
       } else {
         console.log('WebSocket not open, cannot send gemini-complete');
       }
      
      // Clean up temporary image files if any
      if (geminiProcess.tempImagePaths && geminiProcess.tempImagePaths.length > 0) {
        for (const imagePath of geminiProcess.tempImagePaths) {
          await fs.unlink(imagePath).catch(err => {
            // console.error(`Failed to delete temp image ${imagePath}:`, err)
          });
        }
        if (geminiProcess.tempDir) {
          await fs.rm(geminiProcess.tempDir, { recursive: true, force: true }).catch(err => {
            // console.error(`Failed to delete temp directory ${geminiProcess.tempDir}:`, err)
          });
        }
      }
      
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Gemini CLI exited with code ${code}`));
      }
    });
    
    // Handle process errors
    geminiProcess.on('error', (error) => {
      // console.error('Gemini CLI process error:', error);
      
      // Clean up process reference on error
      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeGeminiProcesses.delete(finalSessionId);
      
      ws.send(JSON.stringify({
        type: 'gemini-error',
        error: error.message
      }));
      
      reject(error);
    });
    
    // Handle stdin for interactive mode
    // Gemini with -m flag doesn't need stdin
    if (command && command.trim()) {
      // We're using -m flag, so just close stdin
      geminiProcess.stdin.end();
    } else {
      // Interactive mode without initial prompt
      // Keep stdin open for interactive use
    }
  });
}

function abortGeminiSession(sessionId) {
  // Debug - Attempting to abort Gemini session
  // Debug - Active processes
  
  // Try to find the process by session ID or any key that contains the session ID
  let process = activeGeminiProcesses.get(sessionId);
  let processKey = sessionId;
  
  if (!process) {
    // Search for process with matching session ID in keys
    for (const [key, proc] of activeGeminiProcesses.entries()) {
      if (key.includes(sessionId) || sessionId.includes(key)) {
        process = proc;
        processKey = key;
        break;
      }
    }
  }
  
  if (process) {
    // Debug - Found process for session
    try {
      // First try SIGTERM
      process.kill('SIGTERM');
      
      // Set a timeout to force kill if process doesn't exit
      setTimeout(() => {
        if (activeGeminiProcesses.has(processKey)) {
          // Debug - Process didn't terminate, forcing kill
          try {
            process.kill('SIGKILL');
          } catch (e) {
            // console.error('Error force killing process:', e);
          }
        }
      }, 2000); // Wait 2 seconds before force kill
      
      activeGeminiProcesses.delete(processKey);
      return true;
    } catch (error) {
      // console.error('Error killing process:', error);
      activeGeminiProcesses.delete(processKey);
      return false;
    }
  }
  
  // Debug - No process found for session
  return false;
}

export {
  spawnGemini,
  abortGeminiSession,
  getGeminiSpec
};

async function getGeminiSpec(type, context) {
  console.log('Generating spec for type:', type);
  return new Promise(async (resolve, reject) => {
    let fullResponse = '';
    const args = [];

    const prompt = `Generate a ${type} for a new feature. Here is the context:\n\n${context}`;
    args.push('-m', prompt);

    const geminiPath = process.env.GEMINI_PATH || 'gemini';
    const geminiProcess = spawn(geminiPath, args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    geminiProcess.stdin.end();

    geminiProcess.stdout.on('data', (data) => {
      fullResponse += data.toString();
    });

    geminiProcess.stderr.on('data', (data) => {
      console.error(`Gemini CLI stderr: ${data}`);
    });

    geminiProcess.on('close', (code) => {
      if (code === 0) {
        resolve(fullResponse);
      } else {
        reject(new Error(`Gemini CLI exited with code ${code}`));
      }
    });

    geminiProcess.on('error', (error) => {
      reject(error);
    });
  });
}
