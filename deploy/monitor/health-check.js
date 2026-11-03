#!/usr/bin/env node

// Health check script for WhatsApp bot in GitHub Actions
// This script can be called from GitHub Actions to verify bot health

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const MAX_UPTIME = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const MAX_CRITICAL_EVENTS = 10;
const HEALTH_CHECK_FILE = process.env.LINK_DATA_DIR || path.join(__dirname, '../data/health-check.json');

// Log helper
function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}][${level.toUpperCase()}] ${message}`);
}

// Load health data
function loadHealthData() {
  try {
    if (fs.existsSync(HEALTH_CHECK_FILE)) {
      return JSON.parse(fs.readFileSync(HEALTH_CHECK_FILE, 'utf8'));
    }
  } catch (e) {
    log(`Error loading health data: ${e.message}`, 'error');
  }
  return null;
}

// Save health data
function saveHealthData(data) {
  try {
    const dir = path.dirname(HEALTH_CHECK_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(HEALTH_CHECK_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    log(`Error saving health data: ${e.message}`, 'error');
  }
}

// Check if bot is responsive
function checkBotResponsiveness() {
  try {
    // Check if the process is running
    const psOutput = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV', { encoding: 'utf8' });
    if (psOutput.includes('node.exe')) {
      log('Bot process is running');
      return true;
    } else {
      log('Bot process is not running', 'error');
      return false;
    }
  } catch (e) {
    log(`Error checking bot process: ${e.message}`, 'error');
    return false;
  }
}

// Check session health
function checkSessionHealth() {
  const healthData = loadHealthData();
  if (!healthData) {
    log('No health data available', 'warning');
    return { healthy: false, reason: 'no_health_data' };
  }

  const now = Date.now();
  const uptime = now - (healthData.startTime || 0);
  
  // Check uptime
  if (uptime > MAX_UPTIME) {
    log(`Bot has been running for too long: ${Math.floor(uptime / 1000 / 60 / 60)} hours`, 'warning');
    return { healthy: false, reason: 'max_uptime_exceeded' };
  }

  // Check critical events
  if (healthData.criticalEvents && healthData.criticalEvents.length > MAX_CRITICAL_EVENTS) {
    log(`Too many critical events: ${healthData.criticalEvents.length}`, 'warning');
    return { healthy: false, reason: 'too_many_critical_events' };
  }

  // Check last activity
  if (healthData.lastActivity && (now - healthData.lastActivity) > 300000) { // 5 minutes
    log(`No recent activity for ${Math.floor((now - healthData.lastActivity) / 1000 / 60)} minutes`, 'warning');
    return { healthy: false, reason: 'no_recent_activity' };
  }

  log('Session health check passed');
  return { healthy: true, reason: null };
}

// Enhanced health check with checkpoint verification
async function performEnhancedHealthCheck() {
  log('Starting enhanced health check with checkpoint verification...');
  
  try {
    // Try to load our new checkpoint health check
    let checkpointCheckPassed = false;
    try {
      const { performHealthCheck: checkpointCheck } = require('./checkpoint-health.js');
      checkpointCheckPassed = await checkpointCheck() === 0;
      
      if (checkpointCheckPassed) {
        log('Enhanced checkpoint health check passed');
      } else {
        log('Enhanced checkpoint health check failed', 'error');
      }
    } catch (e) {
      log(`Could not load checkpoint health check: ${e.message}`, 'warning');
      checkpointCheckPassed = false;
    }
    
    // Fall back to basic health check if enhanced check fails or is unavailable
    const processHealthy = checkBotResponsiveness();
    const sessionHealthy = checkSessionHealth();

    const result = {
      timestamp: new Date().toISOString(),
      processHealthy,
      sessionHealthy: sessionHealthy.healthy,
      checkpointHealthy: checkpointCheckPassed,
      reason: sessionHealthy.reason,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      healthData: loadHealthData()
    };

    log(`Health check result: ${result.processHealthy && result.sessionHealthy && result.checkpointHealthy ? 'PASSED' : 'FAILED'}`);

    // Exit with error if any critical check fails
    if (!result.processHealthy || !result.sessionHealthy || !result.checkpointHealthy) {
      log(`Health check failed: ${result.reason || 'unknown reason'}`, 'error');
      process.exit(1);
    }

    // Save health data
    saveHealthData(result);
    
    log('Health check completed successfully');
    process.exit(0);
  } catch (error) {
    log(`Enhanced health check failed with error: ${error.message}`, 'error');
    process.exit(1);
  }
}

// Main health check function
function performHealthCheck() {
  log('Starting health check...');

  const processHealthy = checkBotResponsiveness();
  const sessionHealthy = checkSessionHealth();

  const result = {
    timestamp: new Date().toISOString(),
    processHealthy,
    sessionHealthy: sessionHealthy.healthy,
    reason: sessionHealthy.reason,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    healthData: loadHealthData()
  };

  log(`Health check result: ${result.processHealthy && result.sessionHealthy ? 'PASSED' : 'FAILED'}`);

  if (!result.processHealthy || !result.sessionHealthy) {
    log(`Health check failed: ${result.reason || 'unknown reason'}`, 'error');
    process.exit(1);
  }

  // Save health data
  saveHealthData(result);
  
  log('Health check completed successfully');
  process.exit(0);
}

// Run health check
if (require.main === module) {
  performHealthCheck();
}

module.exports = { performHealthCheck, checkBotResponsiveness, checkSessionHealth };