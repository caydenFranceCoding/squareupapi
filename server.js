const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Client, Environment } = require('square');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

// Updated transaction tracking with more realistic limits
let transactionMetrics = {
  dailyCount: 0,
  hourlyCount: 0,
  lastHourlyReset: new Date().getHours(),
  lastDailyReset: new Date().toDateString(),
  limitReached: false,
  limitType: null,
  limitResetTime: null
};

// More realistic production limits (adjust based on your actual Square account limits)
const PRODUCTION_LIMITS = {
  dailyTransactions: 50000,     // Increased from 10000
  hourlyTransactions: 5000,     // Increased from 1000
  monthlyVolume: 10000000,      // $10M monthly volume
  perTransactionMax: 50000      // $500 max per transaction
};

// For development/testing, use much higher limits or disable
const DEVELOPMENT_LIMITS = {
  dailyTransactions: 100000,
  hourlyTransactions: 10000,
  monthlyVolume: 100000000,
  perTransactionMax: 100000
};

// Choose limits based on environment
const LIMITS = isProduction ? PRODUCTION_LIMITS : DEVELOPMENT_LIMITS;

// Enhanced security headers for production
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://connect.squareup.com", "https://pci-connect.squareup.com"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: "same-origin" }
}));

app.use(express.json({ limit: '1mb' }));

// Enhanced CORS for production
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
      'https://vibebeads.onrender.com',
      'https://vibebeads.net',
      'https://www.vibebeads.net',
      'http://localhost:3000' // Keep for development
    ];
    
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn('CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  maxAge: 86400
};

app.use(cors(corsOptions));

// Production HTTPS enforcement
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

// More lenient rate limiting
const createRateLimiter = (windowMs, max, message, skipSuccessfulRequests = false) => rateLimit({
  windowMs,
  max,
  message: { success: false, error: message },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests,
  handler: (req, res) => {
    console.warn('Rate limit exceeded:', {
      ip: req.ip,
      path: req.path,
      timestamp: new Date().toISOString()
    });
    res.status(429).json({ 
      success: false, 
      error: message,
      retryAfter: Math.ceil(windowMs / 1000)
    });
  }
});

// Updated rate limiters - more lenient
const generalLimiter = createRateLimiter(15 * 60 * 1000, 500, 'Too many requests', true);
const paymentLimiter = createRateLimiter(15 * 60 * 1000, 100, 'Too many payment requests'); // Increased from 50
const configLimiter = createRateLimiter(60 * 1000, 120, 'Too many config requests', true);

// Enhanced logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  req.requestId = requestId;
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logData = {
      requestId,
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      timestamp: new Date().toISOString()
    };
    
    if (res.statusCode >= 400) {
      console.warn('Request warning/error:', logData);
    } else if (req.url.includes('/payments')) {
      console.log('Payment request completed:', logData);
    }
  });
  
  next();
});

// Validate required environment variables
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

// Initialize Square client with enhanced error handling
let squareClient;
try {
  squareClient = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: process.env.SQUARE_ENVIRONMENT === 'production'
      ? Environment.Production
      : Environment.Sandbox,
    customUrl: process.env.SQUARE_ENVIRONMENT === 'production' 
      ? 'https://connect.squareup.com'
      : 'https://connect.squareupsandbox.com'
  });
  
  console.log('Square client initialized:', {
    environment: process.env.SQUARE_ENVIRONMENT,
    locationId: process.env.SQUARE_LOCATION_ID,
    limitsActive: isProduction ? 'Production limits' : 'Development limits',
    timestamp: new Date().toISOString()
  });
} catch (error) {
  console.error('Failed to initialize Square client:', error.message);
  process.exit(1);
}

// Reset transaction counters with better logic
function resetTransactionCounters() {
  const now = new Date();
  const currentHour = now.getHours();
  const currentDate = now.toDateString();
  
  // Reset hourly counter
  if (currentHour !== transactionMetrics.lastHourlyReset) {
    transactionMetrics.hourlyCount = 0;
    transactionMetrics.lastHourlyReset = currentHour;
    
    // Clear hourly limits when resetting
    if (transactionMetrics.limitType === 'hourly') {
      transactionMetrics.limitReached = false;
      transactionMetrics.limitType = null;
      transactionMetrics.limitResetTime = null;
    }
    
    console.log('Hourly transaction counter reset');
  }
  
  // Reset daily counter
  if (currentDate !== transactionMetrics.lastDailyReset) {
    transactionMetrics.dailyCount = 0;
    transactionMetrics.lastDailyReset = currentDate;
    
    // Clear all limits when resetting daily
    transactionMetrics.limitReached = false;
    transactionMetrics.limitType = null;
    transactionMetrics.limitResetTime = null;
    
    console.log('Daily transaction counter reset');
  }
}

// Updated limit checking with more lenient approach
function checkTransactionLimits() {
  resetTransactionCounters();
  
  // In development, be much more lenient or skip limits entirely
  if (!isProduction) {
    console.log('Development mode - transaction limits relaxed');
    return { limited: false };
  }
  
  if (transactionMetrics.dailyCount >= LIMITS.dailyTransactions) {
    transactionMetrics.limitReached = true;
    transactionMetrics.limitType = 'daily';
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    transactionMetrics.limitResetTime = tomorrow;
    
    return { 
      limited: true, 
      type: 'daily', 
      message: `Daily transaction limit of ${LIMITS.dailyTransactions} reached`,
      resetTime: transactionMetrics.limitResetTime
    };
  }
  
  if (transactionMetrics.hourlyCount >= LIMITS.hourlyTransactions) {
    transactionMetrics.limitReached = true;
    transactionMetrics.limitType = 'hourly';
    const nextHour = new Date();
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    transactionMetrics.limitResetTime = nextHour;
    
    return { 
      limited: true, 
      type: 'hourly', 
      message: `Hourly transaction limit of ${LIMITS.hourlyTransactions} reached`,
      resetTime: transactionMetrics.limitResetTime
    };
  }
  
  return { limited: false };
}

// Enhanced health check
app.get('/health', (req, res) => {
  resetTransactionCounters();
  
  const healthCheck = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    environment: process.env.SQUARE_ENVIRONMENT || 'sandbox',
    version: process.env.npm_package_version || '1.0.0',
    transactionMetrics: {
      dailyCount: transactionMetrics.dailyCount,
      hourlyCount: transactionMetrics.hourlyCount,
      limitReached: transactionMetrics.limitReached,
      limitType: transactionMetrics.limitType,
      limits: LIMITS
    },
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
    }
  };
  
  res.json(healthCheck);
});

// Enhanced configuration endpoint
app.get('/api/config', configLimiter, (req, res) => {
  resetTransactionCounters();
  const limitCheck = checkTransactionLimits();
  
  const config = {
    applicationId: process.env.SQUARE_APPLICATION_ID,
    locationId: process.env.SQUARE_LOCATION_ID,
    environment: process.env.SQUARE_ENVIRONMENT || 'sandbox',
    limits: {
      transactionLimitReached: limitCheck.limited,
      limitType: limitCheck.type,
      resetTime: limitCheck.resetTime,
      dailyCount: transactionMetrics.dailyCount,
      hourlyCount: transactionMetrics.hourlyCount,
      maxDailyTransactions: LIMITS.dailyTransactions,
      maxHourlyTransactions: LIMITS.hourlyTransactions
    }
  };
  
  console.log('Configuration requested:', {
    ip: req.ip,
    requestId: req.requestId,
    limitStatus: limitCheck,
    counters: {
      daily: transactionMetrics.dailyCount,
      hourly: transactionMetrics.hourlyCount
    }
  });
  
  res.json(config);
});

// Enhanced input validation
function validatePaymentInput(req, res, next) {
  const { sourceId, amount, currency = 'USD', idempotencyKey } = req.body;
  const errors = [];

  if (!sourceId || typeof sourceId !== 'string' || sourceId.trim().length === 0) {
    errors.push('Valid sourceId is required');
  }

  if (!amount || typeof amount !== 'number') {
    errors.push('Amount must be a number');
  } else if (amount <= 0) {
    errors.push('Amount must be greater than 0');
  } else if (amount > LIMITS.perTransactionMax) {
    errors.push(`Amount cannot exceed $${LIMITS.perTransactionMax.toLocaleString()}`);
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

  // Validate idempotency key length
  if (idempotencyKey && idempotencyKey.length > 45) {
    errors.push('Idempotency key must be 45 characters or less');
  }

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors,
      requestId: req.requestId
    });
  }

  next();
}

// Enhanced Square API test endpoint
app.get('/api/test', generalLimiter, async (req, res) => {
  try {
    const locationsApi = squareClient.locationsApi;
    const response = await locationsApi.listLocations();

    if (response.result && response.result.locations) {
      const testLocation = response.result.locations.find(
        loc => loc.id === process.env.SQUARE_LOCATION_ID
      );
      
      console.log('Square API test successful:', {
        requestId: req.requestId,
        locationFound: !!testLocation,
        totalLocations: response.result.locations.length
      });
      
      res.json({
        success: true,
        message: 'Square API connection successful',
        environment: process.env.SQUARE_ENVIRONMENT || 'sandbox',
        locationCount: response.result.locations.length,
        configuredLocationFound: !!testLocation,
        timestamp: new Date().toISOString(),
        requestId: req.requestId
      });
    } else {
      throw new Error('Invalid response from Square API');
    }
  } catch (error) {
    console.error('Square API test failed:', {
      requestId: req.requestId,
      error: error.message,
      details: error.errors
    });
    
    res.status(500).json({
      success: false,
      error: 'Square API connection failed',
      details: isProduction ? 'Internal server error' : error.message,
      timestamp: new Date().toISOString(),
      requestId: req.requestId
    });
  }
});

// Enhanced payment processing endpoint with better error handling
app.post('/api/payments', paymentLimiter, validatePaymentInput, async (req, res) => {
  const requestId = req.requestId;
  
  try {
    // Check transaction limits before processing - but be more lenient
    const limitCheck = checkTransactionLimits();
    if (limitCheck.limited) {
      console.warn('Transaction limit reached:', {
        requestId,
        limitType: limitCheck.type,
        resetTime: limitCheck.resetTime,
        counters: {
          daily: transactionMetrics.dailyCount,
          hourly: transactionMetrics.hourlyCount
        }
      });
      
      return res.status(429).json({
        success: false,
        error: 'Transaction limit temporarily reached',
        details: [{
          code: 'TRANSACTION_LIMIT',
          category: 'RATE_LIMIT_ERROR',
          detail: limitCheck.message,
          field: 'transaction_count'
        }],
        message: limitCheck.message,
        resetTime: limitCheck.resetTime,
        requestId
      });
    }

    const { 
      sourceId, 
      amount, 
      currency = 'USD', 
      idempotencyKey, 
      buyerEmail,
      billingAddress,
      orderDescription 
    } = req.body;
    
    const paymentsApi = squareClient.paymentsApi;
    const amountInCents = Math.round(amount * 100);

    // Generate secure idempotency key if not provided
    const finalIdempotencyKey = idempotencyKey || 
      `vb_${Date.now()}_${Math.random().toString(36).substr(2, 10)}`.substr(0, 45);

    // Build request body with proper field length limits
    const requestBody = {
      sourceId: sourceId.trim(),
      amountMoney: {
        amount: BigInt(amountInCents),
        currency: currency.toUpperCase()
      },
      locationId: process.env.SQUARE_LOCATION_ID,
      idempotencyKey: finalIdempotencyKey,
      note: orderDescription ? orderDescription.substr(0, 60) : undefined,
      buyerEmailAddress: buyerEmail || undefined
    };

    // Add billing address if provided (with field length validation)
    if (billingAddress) {
      requestBody.billingAddress = {
        firstName: billingAddress.firstName?.substr(0, 45),
        lastName: billingAddress.lastName?.substr(0, 45),
        addressLine1: billingAddress.addressLine1?.substr(0, 60),
        locality: billingAddress.locality?.substr(0, 45),
        administrativeDistrictLevel1: billingAddress.administrativeDistrictLevel1?.substr(0, 45),
        postalCode: billingAddress.postalCode?.substr(0, 20),
        country: billingAddress.country?.substr(0, 2).toUpperCase() || 'US'
      };
    }

    console.log('Processing payment:', {
      requestId,
      amount,
      currency,
      locationId: process.env.SQUARE_LOCATION_ID,
      idempotencyKeyLength: finalIdempotencyKey.length,
      hasBillingAddress: !!billingAddress,
      hasOrderDescription: !!orderDescription,
      counters: {
        daily: transactionMetrics.dailyCount,
        hourly: transactionMetrics.hourlyCount
      }
    });

    const response = await paymentsApi.createPayment(requestBody);

    if (response.result && response.result.payment) {
      const payment = response.result.payment;
      
      // Update transaction counters on successful payment
      transactionMetrics.dailyCount++;
      transactionMetrics.hourlyCount++;
      
      console.log('Payment successful:', {
        requestId,
        paymentId: payment.id,
        status: payment.status,
        amount,
        currency,
        newCounters: {
          daily: transactionMetrics.dailyCount,
          hourly: transactionMetrics.hourlyCount
        }
      });

      res.json({
        success: true,
        paymentId: payment.id,
        status: payment.status,
        amount: amount,
        currency: currency.toUpperCase(),
        timestamp: new Date().toISOString(),
        requestId,
        receiptUrl: payment.receiptUrl || null
      });
    } else {
      console.error('Payment failed - no payment object:', {
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
    console.error('Payment processing error:', {
      requestId,
      error: error.message,
      squareErrors: error.errors,
      statusCode: error.statusCode
    });

    // Handle specific Square API errors
    if (error.errors && Array.isArray(error.errors)) {
      const errorDetails = error.errors.map(err => ({
        code: err.code,
        category: err.category,
        detail: err.detail,
        field: err.field
      }));
      
      // Check for Square API rate limit errors (not our internal limits)
      const hasSquareRateLimit = error.errors.some(err => 
        err.code?.includes('RATE_LIMIT') ||
        err.category === 'RATE_LIMIT_ERROR' ||
        (err.detail?.toLowerCase().includes('rate') && err.detail?.toLowerCase().includes('limit'))
      );
      
      if (hasSquareRateLimit) {
        console.error('Square API rate limit reached (from Square):', {
          requestId,
          errorDetails
        });
        
        return res.status(429).json({
          success: false,
          error: 'Square API rate limit reached',
          details: errorDetails,
          message: 'Payment processing temporarily limited by Square. Please try again in a few minutes.',
          requestId
        });
      }
      
      res.status(400).json({
        success: false,
        error: 'Payment failed',
        details: errorDetails,
        message: error.errors.map(e => e.detail || e.code).join(', '),
        requestId
      });
    } else {
      // Handle network or other errors
      const isNetworkError = error.message?.toLowerCase().includes('network') ||
                           error.message?.toLowerCase().includes('timeout') ||
                           error.code === 'ECONNRESET';
      
      res.status(isNetworkError ? 503 : 500).json({
        success: false,
        error: isNetworkError ? 'Service temporarily unavailable' : 'Payment processing error',
        details: isProduction ? 'Internal server error' : error.message,
        requestId
      });
    }
  }
});

// Transaction metrics endpoint
app.get('/api/metrics', generalLimiter, (req, res) => {
  resetTransactionCounters();
  
  res.json({
    success: true,
    metrics: {
      ...transactionMetrics,
      limits: LIMITS,
      environment: isProduction ? 'production' : 'development',
      timestamp: new Date().toISOString()
    },
    requestId: req.requestId
  });
});

// Reset limits endpoint (for development/testing)
app.post('/api/reset-limits', (req, res) => {
  if (isProduction) {
    return res.status(403).json({
      success: false,
      error: 'Reset not allowed in production',
      requestId: req.requestId
    });
  }
  
  // Reset all counters and limits
  transactionMetrics = {
    dailyCount: 0,
    hourlyCount: 0,
    lastHourlyReset: new Date().getHours(),
    lastDailyReset: new Date().toDateString(),
    limitReached: false,
    limitType: null,
    limitResetTime: null
  };
  
  console.log('Transaction limits reset:', {
    requestId: req.requestId,
    timestamp: new Date().toISOString()
  });
  
  res.json({
    success: true,
    message: 'Transaction limits reset',
    requestId: req.requestId
  });
});

// Enhanced error handling middleware
app.use((err, req, res, next) => {
  const errorId = `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  console.error('Unhandled error:', {
    errorId,
    requestId: req.requestId,
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    timestamp: new Date().toISOString()
  });
  
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    errorId: isProduction ? undefined : errorId,
    requestId: req.requestId
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    availableRoutes: ['/health', '/api/config', '/api/test', '/api/payments', '/api/metrics'],
    requestId: req.requestId
  });
});

// Enhanced process handlers
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', {
    reason,
    promise,
    timestamp: new Date().toISOString()
  });
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', {
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  });
  process.exit(1);
});

// Start server
const server = app.listen(PORT, () => {
  console.log('Server started:', {
    port: PORT,
    environment: process.env.SQUARE_ENVIRONMENT || 'sandbox',
    nodeEnv: process.env.NODE_ENV || 'development',
    limits: isProduction ? 'Production limits active' : 'Development limits (relaxed)',
    timestamp: new Date().toISOString()
  });
});

server.on('close', () => {
  console.log('Server closed at:', new Date().toISOString());
});

// Graceful shutdown timeout
server.on('connection', (socket) => {
  socket.setTimeout(30000); // 30 second timeout
});

module.exports = app;
