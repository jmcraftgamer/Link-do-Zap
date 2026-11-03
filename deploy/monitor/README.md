# WhatsApp Bot Monitoring System

This monitoring system provides comprehensive health monitoring and auto-restart capabilities for the WhatsApp bot running in GitHub Actions.

## Components

### 1. Enhanced WhatsApp Manager (`src/js/whatsapp-manager.js`)

The core WhatsApp manager has been enhanced with:

- **Heartbeat Monitoring**: Tracks activity and detects when the bot becomes unresponsive
- **Critical Event Logging**: Logs important events for diagnostics
- **Auto-Reconnection**: Automatic reconnection when sessions expire or become unresponsive
- **Session Health Tracking**: Monitors individual session health

#### Key Methods Added:

- `startHeartbeat(zapId)`: Starts monitoring a session
- `stopHeartbeat(zapId)`: Stops monitoring a session
- `updateHeartbeat(zapId)`: Updates activity timestamp
- `logCriticalEvent(zapId, eventType, details)`: Logs critical events
- `getSessionHealth(zapId)`: Gets health information for a session
- `getSystemHealth()`: Gets overall system health

### 2. Bot Monitor (`src/js/monitor.js`)

A monitoring class that can be integrated into the main application:

- Periodic health checks
- Critical event tracking
- System health reporting
- Integration with external monitoring systems

### 3. Health Check Script (`deploy/monitor/health-check.js`)

A standalone script for checking bot health:

- Checks if the bot process is running
- Verifies session health
- Checks for excessive uptime
- Validates critical event count
- Can be called from GitHub Actions or other monitoring systems

### 4. Auto-Restart Script (`deploy/monitor/auto-restart.js`)

Automatically restarts the bot if health checks fail:

- Tracks restart history to prevent infinite restart loops
- Performs graceful shutdown and restart
- Logs all restart attempts
- Respects restart limits

### 5. Status Endpoint (`deploy/monitor/status-endpoint.js`)

HTTP server for status monitoring:

- Provides `/status` endpoint with bot health information
- Returns JSON with system status, uptime, memory usage, and session details
- CORS enabled for cross-origin requests

### 6. Enhanced Monitor Script (`deploy/actions/monitor.sh`)

Updated monitor script with enhanced health checks:

- Integrated health-check.js for comprehensive monitoring
- Self-healing capabilities
- Better diagnostics and logging

## Configuration

### Environment Variables

- `LINK_DATA_DIR`: Directory for data storage
- `LINK_HTTP_PORT`: Port for status endpoint (default: 8123)
- `LINK_HTTP_HOST`: Host for status endpoint (default: 127.0.0.1)
- `LINK_MONITOR_ENABLED`: Enable monitoring (default: 0)

### Health Check Thresholds

- Maximum uptime: 24 hours
- Maximum critical events: 10
- Activity timeout: 5 minutes
- Restart window: 5 minutes
- Maximum restarts: 3 per window

## Usage

### 1. Local Testing

```bash
# Start the bot with monitoring
node main.js

# Run health check manually
node deploy/monitor/health-check.js

# Start status endpoint
node deploy/monitor/status-endpoint.js
```

### 2. GitHub Actions Integration

The monitoring system is automatically integrated into the GitHub Actions workflow:

- Health checks are performed every 30 seconds
- Auto-restart is triggered if health checks fail
- Critical events are logged for diagnostics
- Status endpoint is available for external monitoring

### 3. External Monitoring

You can monitor the bot externally:

```bash
# Check status via HTTP
curl http://127.0.0.1:8123/status

# Check health via script
node deploy/monitor/health-check.js
```

## Monitoring Data

### Health Check Response

```json
{
  "status": "healthy|degraded",
  "timestamp": "2026-11-02T10:00:00.000Z",
  "uptime": 3600,
  "memoryUsage": {
    "rss": 123456789,
    "heapTotal": 987654321,
    "heapUsed": 12345678,
    "external": 12345
  },
  "totalSessions": 1,
  "healthySessions": 1,
  "totalCriticalEvents": 0,
  "sessions": [
    {
      "status": "ready",
      "uptime": 3600,
      "lastActivity": 120000,
      "isHealthy": true,
      "criticalEvents": [],
      "sessionUptime": 3600000,
      "phoneNumber": null,
      "reconnecting": false
    }
  ],
  "version": "1.0.0"
}
```

### Critical Event Format

```json
{
  "timestamp": 1667376000000,
  "zapId": "1234567890@c.us",
  "eventType": "session_ready",
  "details": "Session ready at 1667376000 - heartbeat monitoring started",
  "uptime": 3600
}
```

## Troubleshooting

### Common Issues

1. **Bot not responding**
   - Check status endpoint: `curl http://127.0.0.1:8123/status`
   - Review logs for critical events
   - Check if sessions are healthy

2. **Excessive restarts**
   - Check restart log in `data/restart-log.json`
   - Verify root cause of failures
   - Adjust restart limits if needed

3. **Memory issues**
   - Monitor memory usage via status endpoint
   - Check for memory leaks in custom code
   - Consider increasing container memory limits

### Debug Mode

Enable debug logging by setting environment variable:

```bash
export DEBUG=whatsapp-monitor:*
node main.js
```

## Contributing

1. Follow existing code style
2. Add appropriate logging for new features
3. Test changes thoroughly before deployment
4. Update documentation when adding new features

## License

This monitoring system is part of the WhatsApp bot project and follows the same license terms.