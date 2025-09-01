const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Client, Environment } = require('square');
const { body, validationResult, param } = require('express-validator');
const winston = require('winston');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

// Configure Winston logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'square-payment-backend' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    ...(isProduction ? [] : [new winston.transports.Console({
      format: winston.format.simple()
    })])
  ]
});

// Security middleware
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

app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(mongoSanitize());
app.use(xss());

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'];
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
  
  // Force HTTPS in production
  app.use((req, res, next) => {
    if (req.header('x-forwarded-proto') !== 'https') {
      res.redirect(`https://${req.header('host')}${req.url}`);
    } else {
      next();
    }
  });
}

// Enhanced rate limiting
const createRateLimiter = (windowMs, max, message) => rateLimit({
  windowMs,
  max,
  message: { success: false, error: message },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      endpoint: req.path
    });
    res.status(429).json({ success: false, error: message });
  }
});

const generalLimiter = createRateLimiter(15 * 60 * 1000, 100, 'Too many requests');
const paymentLimiter = createRateLimiter(15 * 60 * 1000, 10, 'Too many payment requests');
const configLimiter = createRateLimiter(60 * 1000, 30, 'Too many config requests');

// Request logging
app.use((req, res, next) => {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info('HTTP Request', {
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
  });
  
  next();
});

// Environment validation
const requiredEnvVars = [
  'SQUARE_ACCESS_TOKEN',
  'SQUARE_APPLICATION_ID',
  'SQUARE_LOCATION_ID',
  'SQUARE_ENVIRONMENT'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  logger.error('Missing required environment variables', { missingVars });
  process.exit(1);
}

// Square client initialization with error handling
let squareClient;
try {
  squareClient = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: process.env.SQUARE_ENVIRONMENT === 'production'
      ? Environment.Production
      : Environment.Sandbox,
    customUrl: process.env.SQUARE_CUSTOM_URL
  });
  
  logger.info('Square client initialized', {
    environment: process.env.SQUARE_ENVIRONMENT
  });
} catch (error) {
  logger.error('Failed to initialize Square client', { error: error.message });
  process.exit(1);
}

// Health check endpoint
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

// Configuration endpoint with rate limiting
app.get('/api/config', configLimiter, (req, res) => {
  const config = {
    applicationId: process.env.SQUARE_APPLICATION_ID,
    locationId: process.env.SQUARE_LOCATION_ID,
    environment: process.env.SQUARE_ENVIRONMENT || 'sandbox'
  };
  
  logger.info('Configuration requested', { ip: req.ip });
  res.json(config);
});

// Enhanced validation middleware
const validatePayment = [
  body('sourceId')
    .isString()
    .trim()
    .isLength({ min: 10, max: 255 })
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage('Invalid payment source ID'),
  
  body('amount')
    .isFloat({ min: 0.01, max: 100000 })
    .withMessage('Amount must be between $0.01 and $100,000'),
  
  body('currency')
    .optional()
    .isIn(['USD', 'CAD', 'EUR', 'GBP', 'JPY', 'AUD'])
    .withMessage('Invalid currency code'),
  
  body('idempotencyKey')
    .optional()
    .isString()
    .isLength({ min: 1, max: 128 })
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage('Invalid idempotency key')
];

// Test endpoint with Square API validation
app.get('/api/test', generalLimiter, async (req, res) => {
  try {
    const locationsApi = squareClient.locationsApi;
    const response = await locationsApi.listLocations();

    if (response.result && response.result.locations) {
      logger.info('Square API test successful', {
        locationCount: response.result.locations.length
      });
      
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
    logger.error('Square API test failed', {
      error: error.message,
      stack: error.stack
    });
    
    res.status(500).json({
      success: false,
      error: 'Square API connection failed',
      details: isProduction ? 'Internal server error' : error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Enhanced payment processing endpoint
app.post('/api/payments', paymentLimiter, validatePayment, async (req, res) => {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    // Check validation results
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Payment validation failed', {
        requestId,
        errors: errors.array(),
        ip: req.ip
      });
      
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors.array().map(err => ({
          field: err.path,
          message: err.msg
        })),
        requestId
      });
    }

    const { sourceId, amount, currency = 'USD', idempotencyKey } = req.body;
    const paymentsApi = squareClient.paymentsApi;
    const amountInCents = Math.round(amount * 100);

    // Generate idempotency key if not provided
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
      buyerEmailAddress: req.body.buyerEmail || undefined
    };

    logger.info('Processing payment', {
      requestId,
      amount,
      currency,
      locationId: process.env.SQUARE_LOCATION_ID,
      ip: req.ip
    });

    const response = await paymentsApi.createPayment(requestBody);

    if (response.result && response.result.payment) {
      const payment = response.result.payment;
      
      logger.info('Payment successful', {
        requestId,
        paymentId: payment.id,
        status: payment.status,
        amount,
        currency
      });

      // Store payment record (implement your database logic here)
      // await storePaymentRecord(payment, requestId);

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
      logger.error('Payment failed - no payment object', {
        requestId,
        response: response.result
      });
      
      res.status(400).json({
        success: false,
        error: 'Payment processing failed',
        details: 'No payment object returned',
        requestId
      });
    }
  } catch (error) {
    logger.error('Payment processing error', {
      requestId,
      error: error.message,
      stack: error.stack,
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

// Global error handler
app.use((err, req, res, next) => {
  const errorId = `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  logger.error('Unhandled error', {
    errorId,
    error: err.message,
    stack: err.stack,
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

// 404 handler
app.use('*', (req, res) => {
  logger.warn('Route not found', {
    url: req.url,
    method: req.method,
    ip: req.ip
  });
  
  res.status(404).json({
    success: false,
    error: 'Route not found',
    availableRoutes: ['/health', '/api/config', '/api/test', '/api/payments']
  });
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', { promise, reason });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', { error: error.message, stack: error.stack });
  process.exit(1);
});

const server = app.listen(PORT, () => {
  logger.info('Server started', {
    port: PORT,
    environment: process.env.SQUARE_ENVIRONMENT || 'sandbox',
    nodeEnv: process.env.NODE_ENV || 'development'
  });
});

// Handle server shutdown gracefully
server.on('close', () => {
  logger.info('Server closed');
});

module.exports = app;
