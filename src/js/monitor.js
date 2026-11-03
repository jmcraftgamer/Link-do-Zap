// Simple monitoring script for WhatsApp bot health
// This can be called from GitHub Actions or other monitoring systems

const { WhatsAppManager } = require('./whatsapp-manager');

class BotMonitor {
  constructor(whatsappManager) {
    this.whatsappManager = whatsappManager;
    this.healthCheckInterval = null;
    this.isRunning = false;
  }

  // Start periodic health checks
  start(intervalMs = 30000) {
    if (this.isRunning) return;
    
    this.isRunning = true;
    console.log(`[MONITOR] Starting health checks every ${intervalMs}ms`);
    
    this.healthCheckInterval = setInterval(() => {
      this.checkHealth();
    }, intervalMs);
    
    // Initial check
    this.checkHealth();
  }

  // Stop health checks
  stop() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    console.log('[MONITOR] Health checks stopped');
  }

  // Perform health check
  checkHealth() {
    const systemHealth = this.whatsappManager.getSystemHealth();
    const timestamp = new Date().toISOString();
    
    console.log(`[MONITOR] Health check at ${timestamp}:`, {
      uptime: Math.floor(systemHealth.uptime),
      totalSessions: systemHealth.totalSessions,
      healthySessions: systemHealth.healthySessions,
      totalCriticalEvents: systemHealth.totalCriticalEvents
    });
    
    // Check for critical issues
    if (systemHealth.totalSessions === 0) {
      console.error('[MONITOR] CRITICAL: No active WhatsApp sessions');
      this.logCriticalEvent('system_no_sessions', 'No active WhatsApp sessions');
    }
    
    if (systemHealth.healthySessions === 0 && systemHealth.totalSessions > 0) {
      console.error('[MONITOR] CRITICAL: All sessions are unhealthy');
      this.logCriticalEvent('all_sessions_unhealthy', 'All WhatsApp sessions are unhealthy');
    }
    
    if (systemHealth.totalCriticalEvents > 0) {
      console.warn(`[MONITOR] ${systemHealth.totalCriticalEvents} critical events detected`);
    }
    
    // Log detailed session health
    systemHealth.sessions.forEach((session, index) => {
      if (!session.isHealthy) {
        console.warn(`[MONITOR] Session ${index} unhealthy:`, {
          status: session.status,
          lastActivity: session.lastActivity,
          sessionUptime: session.sessionUptime
        });
      }
    });
    
    return systemHealth;
  }

  // Log critical events (can be extended to send alerts)
  logCriticalEvent(type, details) {
    const timestamp = new Date().toISOString();
    console.error(`[MONITOR][CRITICAL][${type}] ${details} (${timestamp})`);
    
    // Here you could add integration with external monitoring systems
    // like Slack, email, or other alerting services
  }

  // Get health status for API endpoints
  getHealthStatus() {
    const systemHealth = this.whatsappManager.getSystemHealth();
    
    return {
      status: systemHealth.healthySessions === systemHealth.totalSessions && systemHealth.totalSessions > 0 ? 'healthy' : 'degraded',
      ...systemHealth,
      timestamp: new Date().toISOString()
    };
  }
}

// Export for use in other modules
module.exports = { BotMonitor };

// If run directly, perform a one-time health check
if (require.main === module) {
  // This would normally be initialized with the main WhatsAppManager instance
  const monitor = new BotMonitor(null);
  
  // Simulate a health check
  console.log('[MONITOR] Performing one-time health check...');
  console.log('[MONITOR] Note: WhatsAppManager instance not available in standalone mode');
}