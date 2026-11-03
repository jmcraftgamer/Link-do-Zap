#!/usr/bin/env node

/**
 * Enhanced health check script for WhatsApp bot with checkpoint verification
 * This script checks:
 * 1. If bot is responsive via HTTP
 * 2. If session checkpoints are being created regularly
 * 3. If critical events are being logged properly
 * 4. If sessions are healthy
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

// Configuration
const DATA_DIR = process.env.DATA_DIR || process.env.GITHUB_WORKSPACE + '/data';
const CHECKPOINT_DIR = path.join(DATA_DIR, 'checkpoints');
const STATUS_URL = 'http://127.0.0.1:8123/status';
const MAX_CHECKPOINT_AGE = 3600000; // 1 hour in milliseconds
const MAX_CRITICAL_EVENTS = 50;

// Helper function to make HTTP requests
function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          data: data
        });
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// Check if bot is responsive
async function checkBotResponsiveness() {
  try {
    const response = await makeRequest(STATUS_URL, {
      headers: { 'Accept': 'application/json' }
    });
    
    if (response.statusCode !== 200) {
      console.error(`[HEALTH] Bot not responsive - HTTP status: ${response.statusCode}`);
      return false;
    }
    
    try {
      const data = JSON.parse(response.data);
      if (!data || !data.zaps || !Array.isArray(data.zaps)) {
        console.error('[HEALTH] Invalid status response format');
        return false;
      }
      
      const healthyZaps = data.zaps.filter(zap => zap.status === 'ready');
      console.log(`[HEALTH] Bot responsive - ${healthyZaps.length}/${data.zaps.length} zaps ready`);
      
      return true;
    } catch (e) {
      console.error(`[HEALTH] Failed to parse status response: ${e.message}`);
      return false;
    }
  } catch (error) {
    console.error(`[HEALTH] Bot not responsive - ${error.message}`);
    return false;
  }
}

// Check if checkpoints are being created
function checkCheckpoints() {
  try {
    if (!fs.existsSync(CHECKPOINT_DIR)) {
      console.log('[HEALTH] No checkpoint directory found');
      return false;
    }
    
    const checkpointFiles = fs.readdirSync(CHECKPOINT_DIR)
      .filter(file => file.startsWith('session-checkpoint-') && file.endsWith('.json'));
    
    if (checkpointFiles.length === 0) {
      console.log('[HEALTH] No checkpoint files found');
      return false;
    }
    
    let latestCheckpointTime = 0;
    let checkpointStats = [];
    
    checkpointFiles.forEach(file => {
      const filePath = path.join(CHECKPOINT_DIR, file);
      try {
        const checkpoint = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const fileTime = checkpoint.timestamp || 0;
        
        if (fileTime > latestCheckpointTime) {
          latestCheckpointTime = fileTime;
        }
        
        const age = Date.now() - fileTime;
        const status = age > MAX_CHECKPOINT_AGE ? 'stale' : 'fresh';
        
        checkpointStats.push({
          file,
          age,
          status,
          zapId: checkpoint.zapId,
          phoneNumber: checkpoint.phoneNumber
        });
      } catch (e) {
        console.error(`[HEALTH] Failed to read checkpoint file ${file}: ${e.message}`);
      }
    });
    
    const latestCheckpointAge = Date.now() - latestCheckpointTime;
    
    if (latestCheckpointAge > MAX_CHECKPOINT_AGE) {
      console.error(`[HEALTH] Latest checkpoint is stale - age: ${latestCheckpointAge}ms`);
      return false;
    }
    
    console.log(`[HEALTH] Checkpoints OK - ${checkpointFiles.length} files, latest: ${latestCheckpointAge}ms old`);
    checkpointStats.forEach(stat => {
      console.log(`[HEALTH]   ${stat.file}: ${stat.status} (${stat.age}ms) - zap ${stat.zapId} (${stat.phoneNumber})`);
    });
    
    return true;
  } catch (error) {
    console.error(`[HEALTH] Failed to check checkpoints: ${error.message}`);
    return false;
  }
}

// Check critical events
function checkCriticalEvents() {
  try {
    const statusFile = path.join(DATA_DIR, 'bot-status.json');
    if (!fs.existsSync(statusFile)) {
      console.log('[HEALTH] No status file found');
      return true; // Not critical if status file doesn't exist
    }
    
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    
    if (!status.criticalEvents || !Array.isArray(status.criticalEvents)) {
      console.log('[HEALTH] No critical events in status file');
      return true;
    }
    
    const recentEvents = status.criticalEvents.filter(event => {
      const age = Date.now() - (event.timestamp || 0);
      return age < 300000; // 5 minutes
    });
    
    if (recentEvents.length > MAX_CRITICAL_EVENTS) {
      console.error(`[HEALTH] Too many critical events - ${recentEvents.length} in last 5 minutes`);
      return false;
    }
    
    if (recentEvents.length > 0) {
      console.log(`[HEALTH] ${recentEvents.length} recent critical events:`);
      recentEvents.slice(0, 5).forEach(event => {
        console.log(`[HEALTH]   ${new Date(event.timestamp).toISOString()} - ${event.eventType}: ${event.details}`);
      });
    } else {
      console.log('[HEALTH] No recent critical events');
    }
    
    return true;
  } catch (error) {
    console.error(`[HEALTH] Failed to check critical events: ${error.message}`);
    return false;
  }
}

// Main health check function
async function performHealthCheck() {
  console.log('[HEALTH] Starting enhanced health check...');
  
  const checks = [
    { name: 'Bot Responsiveness', check: checkBotResponsiveness },
    { name: 'Checkpoints', check: checkCheckpoints },
    { name: 'Critical Events', check: checkCriticalEvents }
  ];
  
  let allPassed = true;
  
  for (const { name, check } of checks) {
    try {
      console.log(`[HEALTH] Performing ${name} check...`);
      const result = await check();
      
      if (result) {
        console.log(`[HEALTH] ✓ ${name} check passed`);
      } else {
        console.error(`[HEALTH] ✗ ${name} check failed`);
        allPassed = false;
      }
    } catch (error) {
      console.error(`[HEALTH] ✗ ${name} check failed with error: ${error.message}`);
      allPassed = false;
    }
  }
  
  if (allPassed) {
    console.log('[HEALTH] All health checks passed');
    return 0; // Success
  } else {
    console.error('[HEALTH] Some health checks failed');
    return 1; // Failure
  }
}

// Run the health check
if (require.main === module) {
  performHealthCheck()
    .then(process.exit)
    .catch(error => {
      console.error(`[HEALTH] Health check failed with error: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { performHealthCheck };