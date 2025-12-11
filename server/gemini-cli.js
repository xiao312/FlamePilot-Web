import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import sessionManager from './sessionManager.js';
import logger, { auditLogger, logUserEvent } from './logger.js';
import { ensureUserRoot, quotaGuard } from './userPaths.js';

let activeGeminiProcesses = new Map(); // Track active processes by session ID

const PER_MESSAGE_PHOTONS = 3; // Flat cost per user message

function computePhotonChargeForTokens(deltaTokens) {
  // Rate: 3 photons per 1k tokens; round up to whole photons
  const ratePerToken = 3 / 1000;
  const raw = (deltaTokens || 0) * ratePerToken;
  return Math.ceil(raw);
}

async function chargePhotons({ accessKey, clientName, skuId, eventValue }) {
  const numericSkuId = Number(skuId);

  // Dev mode mocking: don't hit real API
  if (process.env.PHOTON_DEV_MODE === '1' && process.env.PHOTON_MOCK === '1') {
    logger.info('[Photon] Dev mock skip', { action: 'photon_mock', eventValue, skuId: numericSkuId });
    return { statusCode: 200, body: { code: 0, mock: true } };
  }

  // Basic validation: ensure we have reasonable inputs
  if (!accessKey || !clientName || !Number.isFinite(numericSkuId) || numericSkuId <= 0 || typeof eventValue !== 'number' || eventValue < 0) {
    throw new Error('Photon charge missing required fields or invalid eventValue');
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
    'User-Agent': 'FlamePilot-Web/1.0',
    'Connection': 'keep-alive',
  };

  const payload = {
    bizNo,
    changeType: 1,
    eventValue,                    // photon amount to deduct
    skuId: numericSkuId,           // each app has a unique skuId
    scene: 'appCustomizeCharge',
  };
  // Debug (mask secrets): log payload and headers (masked)
  auditLogger.info('photon_request_payload', {
    bizNo,
    changeType: payload.changeType,
    eventValue: payload.eventValue,
    skuId: payload.skuId,
    skuIdType: typeof payload.skuId,
    scene: payload.scene,
    accessKeySet: Boolean(accessKey),
    clientNameSet: Boolean(clientName),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  let data;
  try {
    data = await res.json();
  } catch {
    data = { rawText: await res.text() };
  }

  return { statusCode: res.status, body: data };
}

async function spawnGemini(command, options = {}, ws) {
   const startTime = Date.now();
   const commandPreview = String(command || '').slice(0, 120);
   const uid = options.user?.username || options.user?.uid || 'anonymous';
   ensureUserRoot(uid);
   return new Promise(async (resolve, reject) => {
     const { sessionId, projectPath, cwd, resume, toolsSettings, permissionMode, images } = options;
     let capturedSessionId = sessionId; // Track session ID throughout the process
     let sessionCreatedSent = false; // Track if we've already sent session-created event
     let assistantResponse = ''; // Accumulate assistant response from JSON
     let lastTokenCount = 0;   // Track last token usage
     let billedTokenCount = 0; // Track tokens already billed
     let geminiProcess; // Will hold the spawned process reference for fatal billing failures
     let totalPhotonsCharged = 0;
     let chargeStatus = 'pending';
    
    // Dev mode: use env vars; Prod mode: use options from cookies
    const isDevMode = process.env.PHOTON_DEV_MODE === '1';
    const isMock = process.env.PHOTON_MOCK === '1';
    const accessKey = isDevMode ? (process.env.DEV_ACCESS_KEY || options.accessKey) : options.accessKey;
    const clientName = isDevMode ? (process.env.CLIENT_NAME || options.clientName) : options.clientName;
    const rawSku = isDevMode ? (process.env.SKU_ID || options.skuId) : options.skuId;
    const identitySource = isDevMode ? 'dev_env' : (options.user ? 'user' : 'none');
    if (!isDevMode && identitySource === 'none') {
      logger.warn('[Auth] No user identity provided in production mode', { action: 'missing_identity', uid, identitySource });
    }
    const skuId = Number(rawSku);

    const hasValidCredentials = Boolean(
      accessKey &&
      clientName &&
      Number.isFinite(skuId) &&
      skuId > 0 &&
      skuId !== 'your-app-sku-id'
    );
    const cleanAccessKey = accessKey && accessKey.trim();
    const whitelistAccessKeys = new Set(
      (process.env.PHOTON_WHITELIST_ACCESS_KEYS || '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean)
    );
    const whitelistUsers = new Set(
      (process.env.PHOTON_WHITELIST_USERS || '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean)
    );
    const isWhitelisted = (cleanAccessKey && whitelistAccessKeys.has(cleanAccessKey)) ||
      (options.user && (whitelistUsers.has(String(options.user.userId || options.user.uid || options.user.username)) || whitelistUsers.has(options.user.username)));
    // Bill for every user when credentials are present; skip only in explicit mock mode
    const billingEnabledFlag = hasValidCredentials && !isMock;
    const shouldBill = billingEnabledFlag && !isWhitelisted;

   logger.info('call_start', {
     action: 'call_start',
     uid,
     commandPreview,
     shouldBill,
     isWhitelisted,
     console: true
   });
   await logUserEvent(uid, 'call_start', { commandPreview, sessionId: options.sessionId || null, shouldBill, isWhitelisted });

    try {
      quotaGuard(uid);
    } catch (err) {
      logger.warn('Quota exceeded, refusing spawn', { action: 'call_reject_over_quota', uid });
      return reject(err);
    }

    logger.info('[Photon] Session billing config', {
      action: 'photon_config',
      uid,
      isDevMode,
      hasValidCredentials,
      isWhitelisted,
      skuId,
      clientNameSet: Boolean(clientName),
      accessKeySet: Boolean(accessKey),
      accessKeyTail: cleanAccessKey ? cleanAccessKey.slice(-6) : null,
      billingEnabledFlag,
      willBill: shouldBill,
      whitelistCount: whitelistAccessKeys.size,
      identitySource,
      identityUser: options.user || null,
      console: false
    });

    const billPhotons = async ({ photons, tokensUsed, reason }) => {
      if (!billingEnabledFlag) {
        chargeStatus = 'skip_config';
        logger.info('[Photon] Billing disabled by config', { action: 'photon_skip', uid, reason });
        return;
      }
      if (isWhitelisted) {
        chargeStatus = 'skip_whitelist';
        logger.info('[Photon] Billing skipped (whitelist)', { action: 'photon_skip', uid, reason, isWhitelisted });
        return;
      }
      if (!hasValidCredentials || !ws) {
        chargeStatus = 'missing_credentials';
        logger.warn('[Photon] Skipping charge due to missing/invalid credentials', { action: 'photon_skip', uid, hasValidCredentials, skuId, identitySource });
        return;
      }
      if (typeof photons !== 'number' || photons < 0) {
        logger.info('[Photon] Skipping charge due to invalid photons', { action: 'photon_skip', uid, photons, reason });
        return;
      }

      try {
        logger.info('[Photon] Charge attempt', { action: 'photon_charge_attempt', uid, photons, tokensUsed, skuId, reason, isDevMode });
        const chargeResult = await chargePhotons({
          accessKey,
          clientName,
          skuId,
          eventValue: photons,
        });
        const respBody = chargeResult.body || chargeResult;
        const code = respBody && typeof respBody.code === 'number' ? respBody.code : undefined;
        auditLogger.info('photon_charge_response', { uid, photons, tokensUsed, reason, skuId, response: respBody });
        await logUserEvent(uid, 'photon_charge', { photons, tokensUsed, reason, skuId, response: respBody });
        totalPhotonsCharged += photons;
        chargeStatus = 'charged';

        if (code !== undefined && code !== 0) {
          throw new Error(`Photon charge returned code=${code}`);
        }

        ws.send(JSON.stringify({
          type: 'photon-charge',
          data: {
            photonsCharged: photons,
            tokensUsed: tokensUsed,
            price: {
              perMessage: PER_MESSAGE_PHOTONS,
              per1kTokens: 3,
            },
            chargeResponse: respBody,
            reason,
          },
        }));
      } catch (err) {
        chargeStatus = 'charge_error';
        logger.error('[Photon] Charge failed', { action: 'photon_charge_failed', uid, reason, error: err.message });
        ws.send(JSON.stringify({
          type: 'photon-charge',
          error: `Photon charging failed (${reason})`,
          tokensUsed,
        }));
        if (geminiProcess && typeof geminiProcess.kill === 'function') {
          logger.error('[Photon] Killing Gemini process due to billing failure', { action: 'photon_charge_failed_kill', reason });
          try { geminiProcess.kill('SIGTERM'); } catch {}
        }
        // Notify chat flow that billing failed so UI can stop loading
        try {
          ws.send(JSON.stringify({
            type: 'gemini-error',
            error: `Photon billing failed (${reason})`,
          }));
        } catch {}
        throw err;
      }
    };

    // Charge per message as soon as we accept the command
    try {
      await billPhotons({ photons: PER_MESSAGE_PHOTONS, tokensUsed: 0, reason: 'per-message' });
    } catch (err) {
      console.error('[Photon] per-message charge error, aborting spawn:', err);
      // Ensure UI gets an error and the promise rejects
      try {
        ws.send(JSON.stringify({
          type: 'gemini-error',
          error: 'Photon billing failed (per-message)',
        }));
      } catch {}
      return reject(err);
    }

    const sendMessage = (payload) => {
      try {
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(payload));
        }
      } catch {
        // Ignore send errors; connection may be closed
      }
    };

    let stdoutBuffer = '';
    let pendingTokenDelta = 0;
    let billingInFlight = false;

    const processBilling = async (reason) => {
      if (billingInFlight || pendingTokenDelta <= 0) {
        return;
      }
      billingInFlight = true;
      while (pendingTokenDelta > 0) {
        const tokensToBill = pendingTokenDelta;
        pendingTokenDelta = 0;
        const photons = computePhotonChargeForTokens(tokensToBill);
        try {
          await billPhotons({ photons, tokensUsed: tokensToBill, reason });
          billedTokenCount += tokensToBill;
        } catch (err) {
          console.error(`[Photon] ${reason} charge error (continuing):`, err);
        }
      }
      billingInFlight = false;
    };

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
    await logUserEvent(uid, 'gemini_command_init', { args });
    
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
    
    // Try to find gemini in PATH first, then fall back to environment variable
    const geminiPath = process.env.GEMINI_PATH || 'flame-pilot';
    const proxyPrefix = "export http_proxy='http://10.0.1.158:8118' && export https_proxy='http://10.0.1.158:8118' &&";
    const fullCommand = `cd "${workingDir}" && ${proxyPrefix} ${geminiPath} web -m "${promptToUse}"`;
    await logUserEvent(uid, 'gemini_spawn_details', { workingDir, fullCommand, args });
    geminiProcess = spawn('bash', ['-c', fullCommand], {
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
    
    geminiProcess.stdout.on('data', async (data) => {
      const chunk = data.toString();
      stdoutBuffer += chunk;
      logUserEvent(uid, 'cli_stdout', { sessionId: capturedSessionId || sessionId, output: chunk });
      // hasReceivedOutput = true;
      // clearTimeout(timeout);
      
      // Split buffered data into lines; keep trailing partial in buffer
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';

      // Filter out debug messages and system messages
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
            sendMessage(parsed);

            // Track last token usage if present
            const usage = parsed.data && parsed.data.usage;
            if (usage && typeof usage.total_token_count === 'number') {
              lastTokenCount = usage.total_token_count;
              const deltaTokens = lastTokenCount - billedTokenCount;
              if (deltaTokens > 0) {
                pendingTokenDelta += deltaTokens;
                queueMicrotask(() => processBilling('token-delta'));
              }
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
        
        sendMessage({
          type: 'session-created',
          sessionId: capturedSessionId
        });
      }
    });
    
    // Handle stderr
    geminiProcess.stderr.on('data', (data) => {
      const errorMsg = data.toString();
      logUserEvent(uid, 'cli_stderr', { sessionId: capturedSessionId || sessionId, error: errorMsg });
      
      // Filter out deprecation warnings
      if (errorMsg.includes('[DEP0040]') ||
          errorMsg.includes('DeprecationWarning') ||
          errorMsg.includes('--trace-deprecation')) {
        // Log but don't send to client
        // Debug - Gemini CLI warning (suppressed)
        return;
      }

      // Filter benign bash/libtinfo noise
      if (errorMsg.includes('libtinfo') && errorMsg.includes('no version information available')) {
        return;
      }
      
      // console.error('Gemini CLI stderr:', errorMsg);
      sendMessage({
        type: 'gemini-error',
        error: errorMsg
      });
    });

    // Handle process completion
    geminiProcess.on('close', async (code) => {
      // clearTimeout(timeout);
      
      // Clean up process reference
      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeGeminiProcesses.delete(finalSessionId);
      
      // Save assistant response to session if we have one
      if (finalSessionId && assistantResponse.trim()) {
        sessionManager.addMessage(finalSessionId, 'assistant', assistantResponse.trim());
      }

      // --- Photon charging (final delta) ---
      try {
        const remainingTokens = Math.max(0, lastTokenCount - billedTokenCount);
        if (remainingTokens > 0) {
          const photons = computePhotonChargeForTokens(remainingTokens);
          try {
            await billPhotons({ photons, tokensUsed: remainingTokens, reason: 'token-final' });
          } catch (err) {
            logger.error('[Photon] token-final charge error (continuing)', { action: 'photon_charge_failed', uid, error: err.message });
          }
          billedTokenCount = lastTokenCount;
        }
      } catch (err) {
        logger.error('[Photon] Final token charge failed', { action: 'photon_charge_failed', uid, error: err.message });
      }
      // --- Photon charging end ---

       sendMessage({
         type: 'gemini-complete',
         exitCode: code,
         isNewSession: !sessionId && !!command // Flag to indicate this was a new session
       });
      
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

      const durationMs = Date.now() - startTime;
      const status = code === 0 ? 'success' : 'error';
      const tokensUsed = lastTokenCount || 0;
      const photonsCharged = totalPhotonsCharged;
      const finalChargeStatus = shouldBill ? chargeStatus : 'no_billing';

      logger.info('call_complete', {
        action: 'call_complete',
        uid,
        status,
        exitCode: code,
        durationMs,
        tokensUsed,
        photonsCharged,
        chargeStatus: finalChargeStatus,
        shouldBill,
        console: true
      });
      await logUserEvent(uid, 'call_complete', {
        status,
        exitCode: code,
        durationMs,
        tokensUsed,
        photonsCharged,
        chargeStatus: finalChargeStatus,
        sessionId: finalSessionId,
        shouldBill
      });

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
  abortGeminiSession
};
