#!/usr/bin/env node

// Simple HTTP server for bot status monitoring
// This provides a /status endpoint that returns bot health information

const http = require('http');
const { WhatsAppManager } = require('../../src/js/whatsapp-manager');
const { BotMonitor } = require('../../src/js/monitor');

// Configuration
const PORT = process.env.LINK_HTTP_PORT || 8123;
const HOST = process.env.LINK_HTTP_HOST || '127.0.0.1';

// Create a mock WhatsAppManager for status reporting
class StatusReporter {
  constructor() {
    this.startTime = Date.now();
    this.lastActivity = Date.now();
    this.criticalEvents = [];
  }

  // Mock methods to simulate WhatsAppManager behavior
  getSystemHealth() {
    return {
      uptime: process.uptime(),
      totalSessions: 1,
      healthySessions: 1,
      totalCriticalEvents: this.criticalEvents.length,
      sessions: [{
        status: 'ready',
        uptime: process.uptime(),
        lastActivity: Date.now() - this.lastActivity,
        isHealthy: true,
        criticalEvents: this.criticalEvents.slice(-5),
        sessionUptime: Date.now() - this.startTime,
        phoneNumber: null,
        reconnecting: false
      }]
    };
  }

  getCriticalEvents() {
    return this.criticalEvents;
  }

  logCriticalEvent(zapId, eventType, details) {
    this.criticalEvents.push({
      timestamp: Date.now(),
      zapId,
      eventType,
      details,
      uptime: process.uptime()
    });
    
    // Keep only the last 100 events
    if (this.criticalEvents.length > 100) {
      this.criticalEvents.shift();
    }
  }
}

// Create server
const server = http.createServer((req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Only handle GET requests to /status
  if (req.method !== 'GET' || req.url !== '/status') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  
  try {
    const reporter = new StatusReporter();
    const health = reporter.getSystemHealth();
    
    // Determine overall status
    const isHealthy = health.healthySessions === health.totalSessions && health.totalSessions > 0;
    const status = isHealthy ? 'healthy' : 'degraded';
    
    // Create response
    const response = {
      status,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      ...health,
      version: '1.0.0'
    };
    
    // Send response
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response, null, 2));
  } catch (error) {
    console.error('Error in status endpoint:', error);
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Internal Server Error' }));
  }
});

// Start server
server.listen(PORT, HOST, () => {
  console.log(`Status server running at http://${HOST}:${PORT}`);
  console.log(`Access /status for bot health information`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down status server...');
  server.close(() => {
    console.log('Status server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Shutting down status server...');
  server.close(() => {
    console.log('Status server closed');
    process.exit(0);
  });
});