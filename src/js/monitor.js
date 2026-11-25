const { WhatsAppManager } = require('./whatsapp-manager');

class BotMonitor {
  constructor(whatsappManager) {
    this.whatsappManager = whatsappManager;
    this.healthCheckInterval = null;
    this.isRunning = false;
    this.lastStatus = null;
  }

  start(intervalMs = 30000) {
    if (this.isRunning) return;

    this.isRunning = true;
    this.healthCheckInterval = setInterval(() => {
      this.checkHealth();
    }, intervalMs);
    this.checkHealth();
  }

  stop() {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  checkHealth() {
    const systemHealth = this.whatsappManager.getSystemHealth();
    const status = systemHealth.totalSessions === 0 || systemHealth.healthySessions === 0
      ? 'critical'
      : systemHealth.healthySessions < systemHealth.totalSessions
        ? 'degraded'
        : 'healthy';

    if (status !== this.lastStatus) {
      const previousStatus = this.lastStatus;
      this.lastStatus = status;
      const details = `sessoes=${systemHealth.totalSessions}, saudaveis=${systemHealth.healthySessions}`;

      if (status === 'critical') {
        console.error(`[MONITOR] Sistema critico (${details}).`);
      } else if (status === 'degraded') {
        console.warn(`[MONITOR] Sistema degradado (${details}).`);
      } else if (previousStatus) {
        console.log(`[MONITOR] Sistema recuperado (${details}).`);
      }
    }

    return systemHealth;
  }

  getHealthStatus() {
    const systemHealth = this.whatsappManager.getSystemHealth();

    return {
      status: systemHealth.healthySessions === systemHealth.totalSessions && systemHealth.totalSessions > 0 ? 'healthy' : 'degraded',
      ...systemHealth,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = { BotMonitor };

if (require.main === module) {
  console.log('[MONITOR] O monitoramento usa a instancia ativa do WhatsAppManager.');
}
