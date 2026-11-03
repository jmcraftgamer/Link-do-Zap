#!/usr/bin/env node

// Auto-restart script for WhatsApp bot in GitHub Actions
// This script checks the bot health and triggers restarts if needed

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const MAX_RESTARTS = 3; // Maximum restarts within a time window
const RESTART_WINDOW = 300000; // 5 minutes in milliseconds
const HEALTH_CHECK_FILE = process.env.LINK_DATA_DIR || path.join(__dirname, '../../data/health-check.json');
const LOG_FILE = process.env.LINK_DATA_DIR || path.join(__dirname, '../../data/restart-log.json');

// Log helper
function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, level, message };
  
  // Console output
  console.log(`[${timestamp}][${level.toUpperCase()}] ${message}`);
  
  // File logging
  try {
    const logData = [];
    if (fs.existsSync(LOG_FILE)) {
      const existing = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
      if (Array.isArray(existing)) {
        logData.push(...existing.slice(-50)); // Keep last 50 entries
      }
    }
    logData.push(logEntry);
    fs.writeFileSync(LOG_FILE, JSON.stringify(logData, null, 2));
  } catch (e) {
    console.error(`Error writing to log file: ${e.message}`);
  }
}

// Get restart history
function getRestartHistory() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
      if (Array.isArray(data)) {
        return data.filter(entry => entry.level === 'restart');
      }
    }
  } catch (e) {
    log(`Error reading restart history: ${e.message}`, 'error');
  }
  return [];
}

// Check if we should restart
function shouldRestart() {
  const restarts = getRestartHistory();
  const now = Date.now();
  const recentRestarts = restarts.filter(r => (now - new Date(r.timestamp).getTime()) < RESTART_WINDOW);
  
  if (recentRestarts.length >= MAX_RESTARTS) {
    log(`Too many recent restarts: ${recentRestarts.length} in the last ${RESTART_WINDOW/1000} seconds`, 'error');
    return false;
  }
  
  return true;
}

// Perform health check
function performHealthCheck() {
  try {
    // Check if the process is running
    const psOutput = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV', { encoding: 'utf8' });
    if (!psOutput.includes('node.exe')) {
      log('Bot process is not running', 'error');
      return false;
    }
    
    // Check if the container is running
    const containerStatus = execSync('docker ps --format "{{.Names}}"', { encoding: 'utf8' });
    if (!containerStatus.includes('bot')) {
      log('Bot container is not running', 'error');
      return false;
    }
    
    // Check if the bot is responding to HTTP requests
    let statusResponse;
    try {
      statusResponse = execSync('curl -s -m 5 http://127.0.0.1:8123/status', { encoding: 'utf8' });
      if (!statusResponse || statusResponse.includes('error')) {
        log('Bot is not responding to HTTP requests', 'error');
        return false;
      }
    } catch (e) {
      log(`Error checking bot HTTP endpoint: ${e.message}`, 'error');
      return false;
    }
    
    // Check if sessions are healthy
    try {
      const healthData = JSON.parse(statusResponse);
      if (!healthData || !healthData.sessions || healthData.sessions.length === 0) {
        log('No active sessions found', 'error');
        return false;
      }
      
      const healthySessions = healthData.sessions.filter(s => s.isHealthy).length;
      if (healthySessions === 0) {
        log('All sessions are unhealthy', 'error');
        return false;
      }
      
      log(`Health check passed: ${healthySession}/${healthData.sessions.length} sessions healthy`);
      return true;
    } catch (e) {
      log(`Error parsing bot status response: ${e.message}`, 'error');
      return false;
    }
  } catch (e) {
    log(`Error during health check: ${e.message}`, 'error');
    return false;
  }
}

// Restart the bot
function restartBot() {
  if (!shouldRestart()) {
    log('Skipping restart due to restart limit', 'warning');
    return false;
  }
  
  try {
    log('Attempting to restart bot...');
    
    // Stop the container gracefully
    execSync('docker stop -t 90 bot', { encoding: 'utf8' });
    log('Bot container stopped');
    
    // Remove the container
    execSync('docker rm bot', { encoding: 'utf8' });
    log('Bot container removed');
    
    // Start a new container
    execSync('docker run -d --name bot --shm-size=1g --user "$(id -u):$(id -g)" -e HEADLESS=1 -e LINK_DATA_DIR=/data -e LINK_HTTP_PORT=8123 -e LINK_HTTP_HOST=127.0.0.1 -e LINK_AUTO_PAIR=1 -e LINK_HIDE_CODES=1 -e LINK_CODE_FILE=/data/pairing-codes.json -v "$(pwd)/data:/data" linkzap-bot:latest', { 
      encoding: 'utf8',
      stdio: 'inherit'
    });
    
    log('Bot container restarted successfully');
    return true;
  } catch (e) {
    log(`Error restarting bot: ${e.message}`, 'error');
    return false;
  }
}

// Main function
function main() {
  log('Starting auto-restart check...');
  
  if (performHealthCheck()) {
    log('Bot is healthy, no restart needed');
    process.exit(0);
  } else {
    log('Bot is unhealthy, attempting restart...');
    
    if (restartBot()) {
      log('Restart successful');
      process.exit(0);
    } else {
      log('Restart failed', 'error');
      process.exit(1);
    }
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { performHealthCheck, restartBot, shouldRestart };