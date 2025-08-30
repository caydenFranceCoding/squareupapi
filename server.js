const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Client, Environment } = require('square');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());
app.use(express.json());
app.use(cors());

const requiredEnvVars = ['SQUARE_ACCESS_TOKEN', 'SQUARE_APPLICATION_ID'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error('Missing required environment variables:', missingVars);
  process.exit(1);
}

const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENVIRONMENT === 'production'
    ? Environment.Production
    : Environment.Sandbox
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.SQUARE_ENVIRONMENT || 'sandbox'
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    applicationId: process.env.SQUARE_APPLICATION_ID,
    environment: process.env.SQUARE_ENVIRONMENT || 'sandbox'
  });
});

app.get('/api/test', async (req, res) => {
  try {
    const locationsApi = squareClient.locationsApi;
    const response = await locationsApi.listLocations();

    res.json({
      success: true,
      message: 'Square API connection successful',
      environment: process.env.SQUARE_ENVIRONMENT || 'sandbox',
      locationCount: response.result.locations ? response.result.locations.length : 0
    });
  } catch (error) {
    console.error('Square API test error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to connect to Square API',
      details: error.message
    });
  }
});

app.post('/api/payments', async (req, res) => {
  try {
    const { sourceId, amount, currency = 'USD' } = req.body;

    if (!sourceId || !amount) {
      return res.status(400).json({
        success: false,
        error: 'sourceId and amount are required'
      });
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Amount must be a positive number'
      });
    }

    const paymentsApi = squareClient.paymentsApi;
    const amountInCents = Math.round(amount * 100);

    const requestBody = {
      sourceId,
      amountMoney: {
        amount: BigInt(amountInCents),
        currency: currency.toUpperCase()
      },
      idempotencyKey: require('crypto').randomUUID(),
      note: `Payment processed at ${new Date().toISOString()}`
    };

    console.log(`Processing payment: $${amount} ${currency}`);
    const response = await paymentsApi.createPayment(requestBody);

    if (response.result && response.result.payment) {
      console.log(`Payment successful: ${response.result.payment.id}`);
      res.json({
        success: true,
        paymentId: response.result.payment.id,
        status: response.result.payment.status,
        amount: amount,
        currency: currency.toUpperCase(),
        timestamp: new Date().toISOString()
      });
    } else {
      console.log('Payment failed: No payment object in response');
      res.status(400).json({
        success: false,
        error: 'Payment processing failed'
      });
    }
  } catch (error) {
    console.error('Payment error:', error);

    if (error.errors && Array.isArray(error.errors)) {
      const errorMessages = error.errors.map(err => err.detail || err.code).join(', ');
      res.status(400).json({
        success: false,
        error: `Payment failed: ${errorMessages}`
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  }
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Something went wrong!'
  });
});

app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    availableRoutes: ['/health', '/api/config', '/api/test', '/api/payments']
  });
});

app.listen(PORT, () => {
  console.log('Server running on http://localhost:' + PORT);
  console.log('Health check: http://localhost:' + PORT + '/health');
  console.log('Environment: ' + (process.env.SQUARE_ENVIRONMENT || 'sandbox'));
  console.log('Payment endpoint: POST ' + 'http://localhost:' + PORT + '/api/payments');
  console.log('Ready to process payments!');
});