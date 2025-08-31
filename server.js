const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Client, Environment } = require('square');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

app.use(helmet());
app.use(express.json({ limit: '10mb' }));
app.use(cors());

if (isProduction) {
  app.set('trust proxy', 1);
}

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    success: false,
    error: 'Too many requests, please try again later.'
  }
});

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: {
    success: false,
    error: 'Too many payment requests, please try again later.'
  }
});

app.use('/api/', generalLimiter);

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
      details: isProduction ? 'Internal server error' : error.message
    });
  }
});

app.get('/api/debug-locations', async (req, res) => {
  try {
    const locationsApi = squareClient.locationsApi;
    const response = await locationsApi.listLocations();
    
    res.json({
      success: true,
      locations: response.result.locations.map(loc => ({
        id: loc.id,
        name: loc.name,
        status: loc.status,
        address: loc.address
      }))
    });
  } catch (error) {
    console.error('Location fetch error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

function validatePaymentInput(sourceId, amount, currency) {
  const errors = [];

  if (!sourceId || typeof sourceId !== 'string' || sourceId.trim().length === 0) {
    errors.push('Valid sourceId is required');
  }

  if (!amount || typeof amount !== 'number') {
    errors.push('Amount must be a number');
  } else if (amount <= 0) {
    errors.push('Amount must be greater than 0');
  } else if (amount > 100000) {
    errors.push('Amount cannot exceed $100,000');
  } else if (!Number.isFinite(amount)) {
    errors.push('Amount must be a valid number');
  }

  if (currency && typeof currency !== 'string') {
    errors.push('Currency must be a string');
  }

  const validCurrencies = ['USD', 'CAD', 'EUR', 'GBP', 'JPY', 'AUD'];
  if (currency && !validCurrencies.includes(currency.toUpperCase())) {
    errors.push('Unsupported currency');
  }

  return errors;
}

app.post('/api/payments', paymentLimiter, async (req, res) => {
  try {
    const { sourceId, amount, currency = 'USD' } = req.body;

    const validationErrors = validatePaymentInput(sourceId, amount, currency);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: validationErrors
      });
    }

    const paymentsApi = squareClient.paymentsApi;
    const amountInCents = Math.round(amount * 100);

    const requestBody = {
      sourceId: sourceId.trim(),
      amountMoney: {
        amount: BigInt(amountInCents),
        currency: currency.toUpperCase()
      },
      idempotencyKey: require('crypto').randomUUID(),
      note: `Payment processed at ${new Date().toISOString()}`
    };

    if (!isProduction) {
      console.log(`Processing payment: $${amount} ${currency}`);
    }

    const response = await paymentsApi.createPayment(requestBody);

    if (response.result && response.result.payment) {
      if (!isProduction) {
        console.log(`Payment successful: ${response.result.payment.id}`);
      }
      
      res.json({
        success: true,
        paymentId: response.result.payment.id,
        status: response.result.payment.status,
        amount: amount,
        currency: currency.toUpperCase(),
        timestamp: new Date().toISOString()
      });
    } else {
      if (!isProduction) {
        console.log('Payment failed: No payment object in response');
      }
      
      res.status(400).json({
        success: false,
        error: 'Payment processing failed'
      });
    }
  } catch (error) {
    if (!isProduction) {
      console.error('Payment error:', error);
    }

    if (error.errors && Array.isArray(error.errors)) {
      const errorMessages = error.errors.map(err => {
        if (isProduction) {
          return err.code || 'Payment error';
        }
        return err.detail || err.code;
      }).join(', ');
      
      res.status(400).json({
        success: false,
        error: `Payment failed: ${errorMessages}`
      });
    } else {
      res.status(500).json({
        success: false,
        error: isProduction ? 'Payment processing error' : 'Internal server error'
      });
    }
  }
});

app.use((err, req, res, next) => {
  if (!isProduction) {
    console.error('Unhandled error:', err);
  }
  
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

