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
        healthyWebh
