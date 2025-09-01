const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Client, Environment } = require('square');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

app.use(express.json({ limit: '1mb' }));

const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
      'http://localhost:3000',
      'https://vibebeads.net',
      'http://vibebeads.net'
    ];
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  maxAge: 86400
};

app.use(cors(corsOptions));

if (isProduction) {
  app.set('trust proxy', 1);
  
  app.use((req, res, next) => {
    if (req.header('x-forwarded-proto') !== 'https') {
      res.redirect(`https://${req.header('host')}${req.url}`);
    } else {
      next();
    }
  });
}

const createRateLimiter = (windowMs, max, message) => rateLimit({
  windowMs,
  max,
  message: { success: false, error: message },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn('Rate limit exceeded:', req.ip, req.path);
    res.status(429).json({ success: false, error: message });
  }
});

const generalLimiter = createRateLimiter(15 * 60 * 1000, 100, 'Too many requests');
const paymentLimiter = createRateLimiter(15 * 60 * 1000, 10, 'Too many payment requests');
const configLimiter = createRateLimiter(60 * 1000, 30, 'Too many config requests');

app.use((req, res, next) => {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    console.log(`${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
  });
  
  next();
});

const requiredEnvVars = [
  'SQUARE_ACCESS_TOKEN',
  'SQUARE_APPLICATION_ID',
  'SQUARE_LOCATION_ID',
  'SQUARE_ENVIRONMENT'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error('Missing required environment variables:', missingVars);
  process.exit(1);
}

let squareClient;
try {
  squareClient = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: process.env.SQUARE_ENVIRONMENT === 'production'
      ? Environment.Production
      : Environment.Sandbox
  });
  
  console.log('Square client initialized:', process.env.SQUARE_ENVIRONMENT);
} catch (error) {
  console.error('Failed to initialize Square client:', error.message);
  process.exit(1);
}

app.get('/health', (req, res) => {
  const healthCheck = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.SQUARE_ENVIRONMENT || 'sandbox',
    version: process.env.npm_package_version || '1.0.0'
  };
  
  res.json(healthCheck);
});

app.get('/api/config', configLimiter, (req, res) => {
  const config = {
    applicationId: process.env.SQUARE_APPLICATION_ID,
    locationId: process.env.SQUARE_LOCATION_ID,
    environment: process.env.SQUARE_ENVIRONMENT || 'sandbox'
  };
  
  console.log('Configuration requested from:', req.ip);
  res.json(config);
});

function validatePaymentInput(req, res, next) {
  const { sourceId, amount, currency = 'USD' } = req.body;
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

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors
    });
  }

  next();
}

app.get('/api/test', generalLimiter, async (req, res) => {
  try {
    const locationsApi = squareClient.locationsApi;
    const response = await locationsApi.listLocations();

    if (response.result && response.result.locations) {
      console.log('Square API test successful');
      
      res.json({
        success: true,
        message: 'Square API connection successful',
        environment: process.env.SQUARE_ENVIRONMENT || 'sandbox',
        locationCount: response.result.locations.length,
        timestamp: new Date().toISOString()
      });
    } else {
      throw new Error('Invalid response from Square API');
    }
  } catch (error) {
    console.error('Square API test failed:', error.message);
    
    res.status(500).json({
      success: false,
      error: 'Square API connection failed',
      details: isProduction ? 'Internal server error' : error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/payments', paymentLimiter, validatePaymentInput, async (req, res) => {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    const { sourceId, amount, currency = 'USD', idempotencyKey, buyerEmail } = req.body;
    const paymentsApi = squareClient.paymentsApi;
    const amountInCents = Math.round(amount * 100);

    const finalIdempotencyKey = idempotencyKey || 
      `${requestId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const requestBody = {
      sourceId: sourceId.trim(),
      amountMoney: {
        amount: BigInt(amountInCents),
        currency: currency.toUpperCase()
      },
      locationId: process.env.SQUARE_LOCATION_ID,
      idempotencyKey: finalIdempotencyKey,
      note: `Payment processed ${new Date().toISOString()}`,
      buyerEmailAddress: buyerEmail || undefined
    };

    console.log('Processing payment:', {
      requestId,
      amount,
      currency,
      locationId: process.env.SQUARE_LOCATION_ID
    });

    const response = await paymentsApi.createPayment(requestBody);

    if (response.result && response.result.payment) {
      const payment = response.result.payment;
      
      console.log('Payment successful:', {
        requestId,
        paymentId: payment.id,
        status: payment.status,
        amount,
        currency
      });

      res.json({
        success: true,
        paymentId: payment.id,
        status: payment.status,
        amount: amount,
        currency: currency.toUpperCase(),
        timestamp: new Date().toISOString(),
        requestId
      });
    } else {
      console.error('Payment failed - no payment object:', requestId);
      
      res.status(400).json({
        success: false,
        error: 'Payment processing failed',
        details: 'No payment object returned',
        requestId
      });
    }
  } catch (error) {
    console.error('Payment processing error:', {
      requestId,
      error: error.message,
      squareErrors: error.errors
    });

    if (error.errors && Array.isArray(error.errors)) {
      const errorDetails = error.errors.map(err => ({
        code: err.code,
        category: err.category,
        detail: err.detail,
        field: err.field
      }));
      
      res.status(400).json({
        success: false,
        error: 'Payment failed',
        details: errorDetails,
        message: error.errors.map(e => e.detail || e.code).join(', '),
        requestId
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Payment processing error',
        details: isProduction ? 'Internal server error' : error.message,
        requestId
      });
    }
  }
});

app.use((err, req, res, next) => {
  const errorId = `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  console.error('Unhandled error:', {
    errorId,
    error: err.message,
    url: req.url,
    method: req.method,
    ip: req.ip
  });
  
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    errorId: isProduction ? undefined : errorId
  });
});

app.use('*', (req, res) => {
  console.warn('Route not found:', req.url, req.method, req.ip);
  
  res.status(404).json({
    success: false,
    error: 'Route not found',
    availableRoutes: ['/health', '/api/config', '/api/test', '/api/payments']
  });
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

const server = app.listen(PORT, () => {
  console.log('Server started on port:', PORT);
  console.log('Environment:', process.env.SQUARE_ENVIRONMENT || 'sandbox');
  console.log('Node environment:', process.env.NODE_ENV || 'development');
});

server.on('close', () => {
  console.log('Server closed');
});

module.exports = app;
