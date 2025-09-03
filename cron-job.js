const stripe = require('stripe');
require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';
let stripeClient;

// Initialize Stripe client
try {
  stripeClient = stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16',
    timeout: 20000,
    maxNetworkRetries: 2,
    telemetry: false
  });
} catch (error) {
  console.error('❌ Failed to initialize Stripe client:', error.message);
  process.exit(1);
}

class StripeCronJobs {
  /**
   * Keep the server alive by pinging health endpoint
   */
  static async keepAlive() {
    try {
      const serverUrl = process.env.SERVER_URL || process.env.RENDER_EXTERNAL_URL;
      
      if (!serverUrl) {
        return { success: false, error: 'No server URL configured' };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(`${serverUrl}/health`, {
        method: 'GET',
        headers: {
          'User-Agent': 'StripeBackend-HealthCheck/1.0'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      console.log('✅ Keep-alive successful:', {
        status: data.status,
        uptime: data.uptime,
        environment: data.environment,
        timestamp: new Date().toISOString()
      });

      return { 
        success: true, 
        status: data.status,
        uptime: data.uptime,
        environment: data.environment
      };
    } catch (error) {
      console.error('❌ Keep-alive failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Test Stripe API connectivity and account status
   */
  static async testStripeConnection() {
    try {
      // Test basic API connectivity
      const account = await stripeClient.accounts.retrieve();
      
      const accountInfo = {
        id: account.id,
        country: account.country,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        type: account.type
      };

      console.log('✅ Stripe API test successful:', accountInfo);

      // Test webhook endpoints if configured
      let webhookStatus = null;
      try {
        const webhooks = await stripeClient.webhookEndpoints.list({ limit: 10 });
        const activeWebhooks = webhooks.data.filter(wh => wh.status === 'enabled');
        
        webhookStatus = {
          total: webhooks.data.length,
          active: activeWebhooks.length,
          endpoints: activeWebhooks.map(wh => ({
            url: wh.url,
            events: wh.enabled_events.length,
            status: wh.status
          }))
        };
      } catch (webhookError) {
        console.warn('⚠️ Could not fetch webhook info:', webhookError.message);
        webhookStatus = { error: webhookError.message };
      }

      return { 
        success: true, 
        account: accountInfo,
        webhooks: webhookStatus,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('❌ Stripe connection test failed:', {
        error: error.message,
        type: error.type,
        code: error.code,
        requestId: error.requestId
      });
      
      return { 
        success: false, 
        error: error.message,
        type: error.type,
        code: error.code
      };
    }
  }

  /**
   * Check recent payment activity and system health
   */
  static async checkPaymentHealth() {
    try {
      // Get recent payment intents (last 24 hours)
      const yesterday = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
      
      const paymentIntents = await stripeClient.paymentIntents.list({
        created: { gte: yesterday },
        limit: 100
      });

      const checkoutSessions = await stripeClient.checkout.sessions.list({
        created: { gte: yesterday },
        limit: 100
      });

      // Analyze payment statistics
      const paymentStats = {
        totalPaymentIntents: paymentIntents.data.length,
        totalCheckoutSessions: checkoutSessions.data.length,
        successfulPayments: paymentIntents.data.filter(pi => pi.status === 'succeeded').length,
        failedPayments: paymentIntents.data.filter(pi => pi.status === 'payment_failed').length,
        pendingPayments: paymentIntents.data.filter(pi => pi.status === 'processing').length,
        completedSessions: checkoutSessions.data.filter(cs => cs.status === 'complete').length,
        openSessions: checkoutSessions.data.filter(cs => cs.status === 'open').length
      };

      // Calculate success rate
      const totalProcessed = paymentStats.successfulPayments + paymentStats.failedPayments;
      const successRate = totalProcessed > 0 ? (paymentStats.successfulPayments / totalProcessed * 100).toFixed(2) : 'N/A';

      console.log('📊 Payment health check:', {
        ...paymentStats,
        successRate: `${successRate}%`,
        period: '24 hours',
        timestamp: new Date().toISOString()
      });

      // Alert if success rate is too low (< 95%)
      if (totalProcessed > 10 && parseFloat(successRate) < 95) {
        console.warn('⚠️ LOW SUCCESS RATE ALERT:', {
          successRate: `${successRate}%`,
          totalProcessed,
          failedCount: paymentStats.failedPayments
        });
      }

      return {
        success: true,
        stats: paymentStats,
        successRate: `${successRate}%`,
        period: '24 hours',
        alerts: totalProcessed > 10 && parseFloat(successRate) < 95 ? ['LOW_SUCCESS_RATE'] : []
      };
    } catch (error) {
      console.error('❌ Payment health check failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Monitor webhook delivery health
   */
  static async checkWebhookHealth() {
    try {
      if (!process.env.STRIPE_WEBHOOK_SECRET) {
        return { success: false, error: 'No webhook secret configured' };
      }

      // Get webhook endpoints
      const webhooks = await stripeClient.webhookEndpoints.list();
      
      if (webhooks.data.length === 0) {
        return { success: false, error: 'No webhook endpoints configured' };
      }

      const webhookHealth = webhooks.data.map(webhook => {
        const isHealthy = webhook.status === 'enabled';
        const eventCount = webhook.enabled_events.length;
        
        return {
          id: webhook.id,
          url: webhook.url,
          status: webhook.status,
          eventCount,
          healthy: isHealthy,
          created: new Date(webhook.created * 1000).toISOString()
        };
      });

      const healthyCount = webhookHealth.filter(wh => wh.healthy).length;
      const overallHealthy = healthyCount === webhooks.data.length;

      console.log('🔗 Webhook health check:', {
        totalWebhooks: webhooks.data.length,
        healthyWebhooks: healthyCount,
        overallHealthy,
        timestamp: new Date().toISOString()
      });

      return {
        success: true,
        webhooks: webhookHealth,
        summary: {
          total: webhooks.data.length,
          healthy: healthyCount,
          overallHealthy
        }
      };
    } catch (error) {
      console.error('❌ Webhook health check failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Comprehensive health check combining all monitoring
   */
  static async comprehensiveHealthCheck() {
    try {
      console.log('🔍 Starting comprehensive health check...');
      
      const checks = await Promise.allSettled([
        this.keepAlive(),
        this.testStripeConnection(),
        this.checkPaymentHealth(),
        this.checkWebhookHealth()
      ]);

      const results = {
        keepAlive: checks[0].status === 'fulfilled' ? checks[0].value : { success: false, error: checks[0].reason },
        stripeConnection: checks[1].status === 'fulfilled' ? checks[1].value : { success: false, error: checks[1].reason },
        paymentHealth: checks[2].status === 'fulfilled' ? checks[2].value : { success: false, error: checks[2].reason },
        webhookHealth: checks[3].status === 'fulfilled' ? checks[3].value : { success: false, error: checks[3].reason }
      };

      const allSuccessful = Object.values(results).every(result => result.success);
      const failedChecks = Object.entries(results)
        .filter(([_, result]) => !result.success)
        .map(([check, _]) => check);

      const summary = {
        overallHealth: allSuccessful ? 'HEALTHY' : 'DEGRADED',
        totalChecks: 4,
        passedChecks: 4 - failedChecks.length,
        failedChecks,
        timestamp: new Date().toISOString(),
        environment: isProduction ? 'production' : 'development'
      };

      console.log('📋 Health check summary:', summary);

      // Log critical failures
      if (!allSuccessful) {
        console.error('🚨 HEALTH CHECK FAILURES:', {
          failedChecks,
          details: failedChecks.map(check => ({
            check,
            error: results[check].error
          }))
        });
      }

      return {
        success: allSuccessful,
        summary,
        results,
        alerts: failedChecks.length > 0 ? failedChecks : []
      };
    } catch (error) {
      console.error('❌ Comprehensive health check failed:', error.message);
      return { 
        success: false, 
        error: error.message,
        summary: {
          overallHealth: 'CRITICAL',
          timestamp: new Date().toISOString()
        }
      };
    }
  }

  /**
   * Monitor rate limiting and transaction metrics
   */
  static async checkRateLimitHealth() {
    try {
      const serverUrl = process.env.SERVER_URL || process.env.RENDER_EXTERNAL_URL;
      
      if (!serverUrl) {
        return { success: false, error: 'No server URL configured' };
      }

      const response = await fetch(`${serverUrl}/api/metrics`, {
        method: 'GET',
        headers: {
          'User-Agent': 'StripeBackend-MetricsCheck/1.0'
        }
      });

      if (!response.ok) {
        throw new Error(`Metrics endpoint failed: ${response.status}`);
      }

      const metrics = await response.json();

      // Analyze rate limiting
      const rateAnalysis = {
        dailyUsage: metrics.metrics?.transactions?.daily || 0,
        dailyLimit: metrics.metrics?.transactions?.limits?.dailyMax || 0,
        hourlyUsage: metrics.metrics?.transactions?.hourly || 0,
        hourlyLimit: metrics.metrics?.transactions?.limits?.hourlyMax || 0,
        dailyUsagePercent: metrics.metrics?.transactions?.limits?.dailyMax > 0 
          ? ((metrics.metrics.transactions.daily / metrics.metrics.transactions.limits.dailyMax) * 100).toFixed(2)
          : 0,
        hourlyUsagePercent: metrics.metrics?.transactions?.limits?.hourlyMax > 0
          ? ((metrics.metrics.transactions.hourly / metrics.metrics.transactions.limits.hourlyMax) * 100).toFixed(2)
          : 0
      };

      // Volume analysis
      const volumeAnalysis = {
        dailyVolume: metrics.metrics?.volume?.daily || 0,
        monthlyVolume: metrics.metrics?.volume?.monthly || 0,
        dailyVolumeLimit: metrics.metrics?.volume?.limits?.dailyMax || 0,
        monthlyVolumeLimit: metrics.metrics?.volume?.limits?.monthlyMax || 0
      };

      // Generate alerts
      const alerts = [];
      if (parseFloat(rateAnalysis.dailyUsagePercent) > 80) {
        alerts.push(`HIGH_DAILY_USAGE: ${rateAnalysis.dailyUsagePercent}%`);
      }
      if (parseFloat(rateAnalysis.hourlyUsagePercent) > 90) {
        alerts.push(`HIGH_HOURLY_USAGE: ${rateAnalysis.hourlyUsagePercent}%`);
      }

      console.log('📊 Rate limit health check:', {
        rateAnalysis,
        volumeAnalysis,
        alerts,
        timestamp: new Date().toISOString()
      });

      return {
        success: true,
        rateAnalysis,
        volumeAnalysis,
        alerts,
        healthy: alerts.length === 0
      };
    } catch (error) {
      console.error('❌ Rate limit health check failed:', error.message);
      return { success: false, error: error.message };
    }
  }
}

/**
 * Main execution function
 */
async function runCronJob() {
  const jobType = process.argv[2] || 'comprehensive';
  
  console.log('🚀 Starting cron job:', {
    type: jobType,
    environment: isProduction ? 'production' : 'development',
    timestamp: new Date().toISOString()
  });

  let result;
  try {
    switch (jobType) {
      case 'keepAlive':
      case 'keep-alive':
        result = await StripeCronJobs.keepAlive();
        break;
        
      case 'stripe':
      case 'stripeTest':
        result = await StripeCronJobs.testStripeConnection();
        break;
        
      case 'payments':
      case 'paymentHealth':
        result = await StripeCronJobs.checkPaymentHealth();
        break;
        
      case 'webhooks':
      case 'webhookHealth':
        result = await StripeCronJobs.checkWebhookHealth();
        break;
        
      case 'rateLimits':
      case 'metrics':
        result = await StripeCronJobs.checkRateLimitHealth();
        break;
        
      case 'comprehensive':
      case 'all':
      default:
        result = await StripeCronJobs.comprehensiveHealthCheck();
        break;
    }

    // Log final result
    console.log('✅ Cron job completed:', {
      type: jobType,
      success: result.success,
      timestamp: new Date().toISOString(),
      duration: process.hrtime.bigint()
    });

    // Exit with appropriate code
    process.exit(result.success ? 0 : 1);
    
  } catch (error) {
    console.error('❌ Cron job failed with exception:', {
      type: jobType,
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    
    process.exit(1);
  }
}

// Handle process signals
process.on('SIGTERM', () => {
  console.log('📡 SIGTERM received, shutting down cron job gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('📡 SIGINT received, shutting down cron job gracefully...');
  process.exit(0);
});

// Handle unhandled errors
process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 Unhandled Rejection in cron job:', {
    reason: reason?.message || reason,
    promise,
    timestamp: new Date().toISOString()
  });
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('🔥 Uncaught Exception in cron job:', {
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  });
  process.exit(1);
});

// Run the job if this file is executed directly
if (require.main === module) {
  runCronJob().catch(error => {
    console.error('❌ Fatal cron job error:', error);
    process.exit(1);
  });
}

module.exports = { StripeCronJobs };
