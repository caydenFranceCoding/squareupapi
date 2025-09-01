const https = require('https');
const http = require('http');
require('dotenv').config();

class KeepAliveService {
  constructor() {
    this.serverUrl = process.env.SERVER_URL || process.env.RENDER_EXTERNAL_URL;
    this.pingInterval = 14 * 60 * 1000; // 14 minutes
    this.maxRetries = 3;
    this.isRunning = false;
    
    if (!this.serverUrl) {
      process.exit(1);
    }
  }

  async pingServer(retryCount = 0) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.serverUrl}/health`);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;
      
      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'GET',
        timeout: 30000,
        headers: {
          'User-Agent': 'Keep-Alive-Service/1.0',
          'Accept': 'application/json'
        }
      };

      const req = client.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve({ success: true, statusCode: res.statusCode });
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.end();
    });
  }

  async pingWithRetry() {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        await this.pingServer();
        return true;
      } catch (error) {
        if (attempt === this.maxRetries) {
          return false;
        }
        await this.sleep(5000); // 5 second delay between retries
      }
    }
    return false;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    
    // Initial ping
    this.pingWithRetry();
    
    // Set up interval
    this.intervalId = setInterval(() => {
      this.pingWithRetry();
    }, this.pingInterval);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
  }
}

// Initialize and start the service
const keepAlive = new KeepAliveService();

process.on('SIGTERM', () => {
  keepAlive.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  keepAlive.stop();
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  // Handle silently in production
});

process.on('uncaughtException', (error) => {
  process.exit(1);
});

keepAlive.start();
