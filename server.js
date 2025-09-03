const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const stripe = require('stripe');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

// Validate required environment variables
const requiredEnvVars = [
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error('CRITICAL: Missing required environment variables:', missingVars);
  console.error('Required variables: STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, ALLOWED_ORIGINS');
  process.exit(1);
}

// Initialize Stripe with error handling
let stripeClient;
try {
  stripeClient = stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16',
    timeout: 20000, // 20 second timeout
    maxNetworkRetries: 3,
    telemetry: false, // Disable telemetry for security
    appInfo: {
      name: 'VibeBeads Payment System',
      version: '1.0.0',
      url: process.env.ALLOWED_ORIGINS?.split(',')[0] || 'https://vibebeads.net'
    }
  });
  
  console.log('✅ Stripe client initialized successfully');
} catch (error) {
  console.error('❌ Failed to initialize Stripe client:', error.message);
  process.exit(1);
}

// Transaction tracking for monitoring and rate limiting
let transactionMetrics = {
  dailyCount: 0,
  hourlyCount: 0,
  lastHourlyReset: new Date().getHours(),
  lastDailyReset: new Date().toDateString(),
  limitReached: false,
  limitType: null,
  limitResetTime: null,
  dailyVolume: 0,
  monthlyVolume: 0,
  lastMonthlyReset: new Date().getMonth()
};

// Production limits (adjust based on your Stripe account limits)
const PRODUCTION_LIMITS = {
  dailyTransactions: 10000,
  hourlyTransactions: 1000,
  dailyVolume: 1000000, // $10,000 daily volume
  monthlyVolume: 10000000, // $100,000 monthly volume
  perTransactionMax: 100000, // $1,000 max per transaction
  perTransactionMin: 50 // $0.50 minimum
};

const DEVELOPMENT_LIMITS = {
  dailyTransactions: 100000,
  hourlyTransactions: 10000,
  dailyVolume: 100000000,
  monthlyVolume: 1000000000,
  perTransactionMax: 100000,
  perTransactionMin: 50
};

const LIMITS = isProduction ? PRODUCTION_LIMITS : DEVELOPMENT_LIMITS;

// Security middleware with production-grade settings
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "https://js.stripe.com"],
      frameSrc: ["'self'", "https://js.stripe.com", "https://checkout.stripe.com"],
      imgSrc: ["'self'", "data:", "https:", "https://*.stripe.com"],
      connectSrc: ["'self'", "https://api.stripe.com", "https://checkout.stripe.com"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  crossOriginEmbedderPolicy: false // Required for Stripe
}));

// Body parsing with size limits
app.use('/api/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

// Production CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || [];
    
    if (!isProduction) {
      allowedOrigins.push('http://localhost:3000', 'http://localhost:3001');
    }
    
    // Allow requests with no origin (mobile apps, server-to-server)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn('🚨 CORS violation:', { origin, allowed: allowedOrigins, timestamp: new Date().toISOString() });
      callback(new Error('Access denied by CORS policy'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'stripe-signature'],
  maxAge: 86400,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// HTTPS enforcement for production
if (isProduction) {
  app.set('trust proxy', 1);
  
  app.use((req, res, next) => {
    if (req.header('x-forwarded-proto') !== 'https' && !req.url.startsWith('/health')) {
      return res.redirect(301, `https://${req.header('host')}${req.url}`);
    }
    next();
  });
}

// Advanced rate limiting with different tiers
const createRateLimiter = (windowMs, max, message, keyGenerator = null, skipSuccessfulRequests = false) => rateLimit({
  windowMs,
  max,
  message: { success: false, error: message, code: 'RATE_LIMIT_EXCEEDED' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests,
  keyGenerator: keyGenerator || ((req) => `${req.ip}:${req.path}`),
  handler: (req, res, next) => {
    console.warn('⚠️ Rate limit exceeded:', {
      ip: req.ip,
      path: req.path,
      userAgent: req.get('User-Agent'),
      timestamp: new Date().toISOString(),
      requestId: req.requestId
    });
    res.status(429).json({ 
      success: false, 
      error: message,
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfter: Math.ceil(windowMs / 1000),
      requestId: req.requestId
    });
  }
});

// Multi-tier rate limiting
const globalLimiter = createRateLimiter(15 * 60 * 1000, 1000, 'Too many requests from this IP', null, true);
const checkoutLimiter = createRateLimiter(15 * 60 * 1000, 100, 'Too many checkout requests');
const webhookLimiter = createRateLimiter(60 * 1000, 200, 'Webhook rate limit exceeded');
const configLimiter = createRateLimiter(60 * 1000, 300, 'Too many config requests', null, true);

// Request tracking middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  const requestId = `req_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  
  req.requestId = requestId;
  req.startTime = startTime;
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logData = {
      requestId,
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.get('User-Agent')?.substring(0, 100),
      timestamp: new Date().toISOString()
    };
    
    if (res.statusCode >= 500) {
      console.error('🔥 Server error:', logData);
    } else if (res.statusCode >= 400) {
      console.warn('⚠️ Client error:', logData);
    } else if (req.url.includes('/checkout') || req.url.includes('/webhook')) {
      console.log('💳 Payment operation:', logData);
    }
  });
  
  next();
});

// Global limiter applied to all routes
app.use(globalLimiter);

// Reset transaction counters with comprehensive logic
function resetTransactionCounters() {
  const now = new Date();
  const currentHour = now.getHours();
  const currentDate = now.toDateString();
  const currentMonth = now.getMonth();
  
  // Reset hourly counter
  if (currentHour !== transactionMetrics.lastHourlyReset) {
    transactionMetrics.hourlyCount = 0;
    transactionMetrics.lastHourlyReset = currentHour;
    
    if (transactionMetrics.limitType === 'hourly') {
      transactionMetrics.limitReached = false;
      transactionMetrics.limitType = null;
      transactionMetrics.limitResetTime = null;
    }
  }
  
  // Reset daily counter and volume
  if (currentDate !== transactionMetrics.lastDailyReset) {
    transactionMetrics.dailyCount = 0;
    transactionMetrics.dailyVolume = 0;
    transactionMetrics.lastDailyReset = currentDate;
    
    if (transactionMetrics.limitType === 'daily') {
      transactionMetrics.limitReached = false;
      transactionMetrics.limitType = null;
      transactionMetrics.limitResetTime = null;
    }
    
    console.log('📊 Daily metrics reset');
  }
  
  // Reset monthly volume
  if (currentMonth !== transactionMetrics.lastMonthlyReset) {
    transactionMetrics.monthlyVolume = 0;
    transactionMetrics.lastMonthlyReset = currentMonth;
    
    if (transactionMetrics.limitType === 'monthly') {
      transactionMetrics.limitReached = false;
      transactionMetrics.limitType = null;
      transactionMetrics.limitResetTime = null;
    }
    
    console.log('📊 Monthly metrics reset');
  }
}

// Comprehensive limit checking
function checkTransactionLimits(amount = 0) {
  resetTransactionCounters();
  
  // More lenient in development
  if (!isProduction) {
    return { limited: false };
  }
  
  // Check transaction count limits
  if (transactionMetrics.dailyCount >= LIMITS.dailyTransactions) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    return { 
      limited: true, 
      type: 'daily_count', 
      message: `Daily transaction limit of ${LIMITS.dailyTransactions.toLocaleString()} reached`,
      resetTime: tomorrow
    };
  }
  
  if (transactionMetrics.hourlyCount >= LIMITS.hourlyTransactions) {
    const nextHour = new Date();
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    
    return { 
      limited: true, 
      type: 'hourly_count', 
      message: `Hourly transaction limit of ${LIMITS.hourlyTransactions.toLocaleString()} reached`,
      resetTime: nextHour
    };
  }
  
  // Check volume limits
  const amountInDollars = amount / 100;
  if ((transactionMetrics.dailyVolume + amountInDollars) > LIMITS.dailyVolume) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    return { 
      limited: true, 
      type: 'daily_volume', 
      message: `Daily volume limit of $${LIMITS.dailyVolume.toLocaleString()} would be exceeded`,
      resetTime: tomorrow
    };
  }
  
  if ((transactionMetrics.monthlyVolume + amountInDollars) > LIMITS.monthlyVolume) {
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1, 1);
    nextMonth.setHours(0, 0, 0, 0);
    
    return { 
      limited: true, 
      type: 'monthly_volume', 
      message: `Monthly volume limit of $${LIMITS.monthlyVolume.toLocaleString()} would be exceeded`,
      resetTime: nextMonth
    };
  }
  
  return { limited: false };
}

// Health check endpoint
app.get('/health', (req, res) => {
  resetTransactionCounters();
  
  const healthCheck = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    environment: isProduction ? 'production' : 'development',
    version: process.env.npm_package_version || '1.0.0',
    stripe: {
      connected: !!stripeClient,
      apiVersion: '2023-10-16'
    },
    metrics: {
      daily: {
        transactions: transactionMetrics.dailyCount,
        volume: `$${transactionMetrics.dailyVolume.toLocaleString()}`
      },
      hourly: {
        transactions: transactionMetrics.hourlyCount
      },
      limits: {
        reached: transactionMetrics.limitReached,
        type: transactionMetrics.limitType
      }
    },
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
    }
  };
  
  res.json(healthCheck);
});

// Configuration endpoint
app.get('/api/config', configLimiter, (req, res) => {
  resetTransactionCounters();
  const limitCheck = checkTransactionLimits();
  
  const config = {
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    environment: isProduction ? 'production' : 'development',
    limits: {
      transactionLimitReached: limitCheck.limited,
      limitType: limitCheck.type,
      resetTime: limitCheck.resetTime,
      maxAmount: LIMITS.perTransactionMax,
      minAmount: LIMITS.perTransactionMin,
      dailyTransactions: transactionMetrics.dailyCount,
      maxDailyTransactions: LIMITS.dailyTransactions
    },
    features: {
      applePay: true,
      googlePay: true,
      cards: true,
      bankTransfers: false // Configure based on your needs
    }
  };
  
  res.json(config);
});

// Input validation middleware
function validateCheckoutInput(req, res, next) {
  const { 
    amount, 
    currency = 'USD', 
    successUrl, 
    cancelUrl,
    customerEmail,
    lineItems,
    mode = 'payment'
  } = req.body;
  
  const errors = [];
  
  // Validate amount
  if (!amount || typeof amount !== 'number') {
    errors.push('Amount must be a number');
  } else if (amount < LIMITS.perTransactionMin) {
    errors.push(`Amount must be at least $${(LIMITS.perTransactionMin / 100).toFixed(2)}`);
  } else if (amount > LIMITS.perTransactionMax) {
    errors.push(`Amount cannot exceed $${(LIMITS.perTransactionMax / 100).toLocaleString()}`);
  } else if (!Number.isFinite(amount) || amount <= 0) {
    errors.push('Amount must be a positive number');
  }
  
  // Validate currency
  const supportedCurrencies = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'];
  if (!supportedCurrencies.includes(currency?.toUpperCase())) {
    errors.push(`Currency must be one of: ${supportedCurrencies.join(', ')}`);
  }
  
  // Validate URLs
  const urlRegex = /^https?:\/\/[^\s]+$/;
  if (!successUrl || !urlRegex.test(successUrl)) {
    errors.push('Valid success URL is required');
  }
  if (!cancelUrl || !urlRegex.test(cancelUrl)) {
    errors.push('Valid cancel URL is required');
  }
  
  // Validate email if provided
  if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    errors.push('Invalid email address format');
  }
  
  // Validate mode
  if (!['payment', 'subscription'].includes(mode)) {
    errors.push('Mode must be either "payment" or "subscription"');
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

// Stripe API test endpoint
app.get('/api/test', async (req, res) => {
  try {
    // Test Stripe connection by fetching account info
    const account = await stripeClient.accounts.retrieve();
    
    console.log('✅ Stripe API test successful:', {
      requestId: req.requestId,
      accountId: account.id,
      country: account.country,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled
    });
    
    res.json({
      success: true,
      message: 'Stripe API connection successful',
      environment: isProduction ? 'production' : 'development',
      account: {
        id: account.id,
        country: account.country,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        businessProfile: account.business_profile?.name || 'Not set'
      },
      timestamp: new Date().toISOString(),
      requestId: req.requestId
    });
  } catch (error) {
    console.error('❌ Stripe API test failed:', {
      requestId: req.requestId,
      error: error.message,
      type: error.type,
      code: error.code
    });
    
    res.status(500).json({
      success: false,
      error: 'Stripe API connection failed',
      details: isProduction ? 'Service temporarily unavailable' : error.message,
      type: error.type,
      timestamp: new Date().toISOString(),
      requestId: req.requestId
    });
  }
});

// Create Checkout Session endpoint
app.post('/api/create-checkout-session', checkoutLimiter, validateCheckoutInput, async (req, res) => {
  const requestId = req.requestId;
  
  try {
    const {
      amount,
      currency = 'USD',
      successUrl,
      cancelUrl,
      customerEmail,
      lineItems = [],
      mode = 'payment',
      customerName,
      allowPromotionCodes = false,
      automaticTax = false
    } = req.body;
    
    // Check transaction limits
    const limitCheck = checkTransactionLimits(amount);
    if (limitCheck.limited) {
      console.warn('🚫 Transaction limit reached:', {
        requestId,
        limitType: limitCheck.type,
        resetTime: limitCheck.resetTime
      });
      
      return res.status(429).json({
        success: false,
        error: 'Transaction limit reached',
        details: limitCheck.message,
        resetTime: limitCheck.resetTime,
        requestId
      });
    }
    
    // Prepare line items
    let sessionLineItems;
    if (lineItems.length > 0) {
      sessionLineItems = lineItems.map(item => ({
        price_data: {
          currency: currency.toLowerCase(),
          product_data: {
            name: item.name,
            description: item.description,
            images: item.images || []
          },
          unit_amount: item.amount,
        },
        quantity: item.quantity || 1,
      }));
    } else {
      // Fallback single item
      sessionLineItems = [{
        price_data: {
          currency: currency.toLowerCase(),
          product_data: {
            name: 'Purchase',
            description: 'Payment for services'
          },
          unit_amount: amount,
        },
        quantity: 1,
      }];
    }
    
    // Prepare customer data
    let customerData = {};
    if (customerEmail) {
      customerData.customer_email = customerEmail;
    }
    
    // Create checkout session
    const sessionParams = {
      payment_method_types: ['card'],
      line_items: sessionLineItems,
      mode,
      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      allow_promotion_codes: allowPromotionCodes,
      billing_address_collection: 'required',
      shipping_address_collection: {
        allowed_countries: ['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'IT', 'ES', 'NL'] // Adjust based on your needs
      },
      payment_intent_data: {
        metadata: {
          requestId,
          source: 'vibebeads_checkout',
          timestamp: new Date().toISOString()
        }
      },
      metadata: {
        requestId,
        customerName: customerName || '',
        source: 'vibebeads_checkout'
      },
      expires_at: Math.floor(Date.now() / 1000) + (30 * 60), // 30 minutes expiry
      ...customerData
    };
    
    // Add automatic tax if enabled
    if (automaticTax) {
      sessionParams.automatic_tax = { enabled: true };
    }
    
    console.log('💳 Creating Stripe checkout session:', {
      requestId,
      amount,
      currency,
      itemCount: sessionLineItems.length,
      hasCustomerEmail: !!customerEmail,
      mode
    });
    
    const session = await stripeClient.checkout.sessions.create(sessionParams);
    
    // Update transaction counters
    transactionMetrics.dailyCount++;
    transactionMetrics.hourlyCount++;
    transactionMetrics.dailyVolume += (amount / 100);
    transactionMetrics.monthlyVolume += (amount / 100);
    
    console.log('✅ Checkout session created:', {
      requestId,
      sessionId: session.id,
      amount,
      currency,
      customerEmail,
      newCounters: {
        daily: transactionMetrics.dailyCount,
        hourly: transactionMetrics.hourlyCount,
        dailyVolume: transactionMetrics.dailyVolume
      }
    });
    
    res.json({
      success: true,
      sessionId: session.id,
      url: session.url,
      amount,
      currency: currency.toUpperCase(),
      expiresAt: new Date(session.expires_at * 1000).toISOString(),
      timestamp: new Date().toISOString(),
      requestId
    });
    
  } catch (error) {
    console.error('❌ Checkout session creation failed:', {
      requestId,
      error: error.message,
      type: error.type,
      code: error.code,
      stripeRequestId: error.requestId
    });
    
    // Handle specific Stripe errors
    let statusCode = 500;
    let errorMessage = 'Checkout session creation failed';
    
    if (error.type === 'StripeCardError') {
      statusCode = 400;
      errorMessage = 'Payment method error';
    } else if (error.type === 'StripeRateLimitError') {
      statusCode = 429;
      errorMessage = 'Rate limit exceeded';
    } else if (error.type === 'StripeInvalidRequestError') {
      statusCode = 400;
      errorMessage = 'Invalid request parameters';
    } else if (error.type === 'StripeAPIError') {
      statusCode = 502;
      errorMessage = 'Stripe API error';
    } else if (error.type === 'StripeConnectionError') {
      statusCode = 503;
      errorMessage = 'Connection error';
    }
    
    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      details: isProduction ? 'Please try again later' : error.message,
      type: error.type,
      code: error.code,
      requestId
    });
  }
});

// Retrieve checkout session endpoint
app.get('/api/checkout-session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const requestId = req.requestId;
  
  try {
    const session = await stripeClient.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent', 'customer']
    });
    
    console.log('📋 Checkout session retrieved:', {
      requestId,
      sessionId,
      status: session.status,
      paymentStatus: session.payment_status
    });
    
    res.json({
      success: true,
      session: {
        id: session.id,
        status: session.status,
        paymentStatus: session.payment_status,
        customerEmail: session.customer_details?.email,
        amountTotal: session.amount_total,
        currency: session.currency,
        paymentIntentId: session.payment_intent?.id,
        created: new Date(session.created * 1000).toISOString()
      },
      requestId
    });
    
  } catch (error) {
    console.error('❌ Session retrieval failed:', {
      requestId,
      sessionId,
      error: error.message,
      type: error.type
    });
    
    const statusCode = error.type === 'StripeInvalidRequestError' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: 'Session retrieval failed',
      details: isProduction ? 'Session not found or expired' : error.message,
      requestId
    });
  }
});

// Webhook endpoint for Stripe events
app.post('/api/webhook', webhookLimiter, async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const requestId = req.requestId;
  let event;
  
  try {
    event = stripeClient.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', {
      requestId,
      error: err.message
    });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  console.log('📨 Webhook received:', {
    requestId,
    type: event.type,
    id: event.id,
    created: new Date(event.created * 1000).toISOString()
  });
  
  // Handle the event
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        console.log('✅ Payment successful:', {
          sessionId: session.id,
          amount: session.amount_total,
          currency: session.currency,
          customerEmail: session.customer_details?.email,
          paymentIntentId: session.payment_intent
        });
        
        // TODO: Fulfill order, send confirmation email, update database
        await handleSuccessfulPayment(session);
        break;
        
      case 'checkout.session.expired':
        const expiredSession = event.data.object;
        console.log('⏰ Checkout session expired:', {
          sessionId: expiredSession.id,
          amount: expiredSession.amount_total
        });
        break;
        
      case 'payment_intent.payment_failed':
        const failedPaymentIntent = event.data.object;
        console.log('❌ Payment failed:', {
          paymentIntentId: failedPaymentIntent.id,
          amount: failedPaymentIntent.amount,
          lastPaymentError: failedPaymentIntent.last_payment_error?.message
        });
        break;
        
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
    
    res.json({ received: true, requestId });
    
  } catch (error) {
    console.error('❌ Webhook processing error:', {
      requestId,
      eventType: event.type,
      eventId: event.id,
      error: error.message
    });
    res.status(500).json({ error: 'Webhook processing failed', requestId });
  }
});

// Handle successful payment (customize based on your needs)
async function handleSuccessfulPayment(session) {
  try {
    // Extract order details from session metadata
    const orderDetails = {
      sessionId: session.id,
      paymentIntentId: session.payment_intent,
      amount: session.amount_total,
      currency: session.currency,
      customerEmail: session.customer_details?.email,
      customerName: session.customer_details?.name,
      shippingAddress: session.shipping_details?.address,
      timestamp: new Date().toISOString()
    };
    
    console.log('📦 Processing successful order:', orderDetails);
    
    // TODO: Implement your order fulfillment logic here:
    // - Save order to database
    // - Update inventory
    // - Send confirmation email
    // - Trigger shipping process
    // - Send webhook to other services
    
    return orderDetails;
  } catch (error) {
    console.error('❌ Order fulfillment error:', error.message);
    throw error;
  }
}

// Metrics endpoint
app.get('/api/metrics', (req, res) => {
  resetTransactionCounters();
  
  res.json({
    success: true,
    metrics: {
      transactions: {
        daily: transactionMetrics.dailyCount,
        hourly: transactionMetrics.hourlyCount,
        limits: {
          dailyMax: LIMITS.dailyTransactions,
          hourlyMax: LIMITS.hourlyTransactions
        }
      },
      volume: {
        daily: transactionMetrics.dailyVolume,
        monthly: transactionMetrics.monthlyVolume,
        limits: {
          dailyMax: LIMITS.dailyVolume,
          monthlyMax: LIMITS.monthlyVolume
        }
      },
      system: {
        environment: isProduction ? 'production' : 'development',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
      }
    },
    requestId: req.requestId
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  const errorId = `err_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  
  console.error('🔥 Unhandled error:', {
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
    error: 'Endpoint not found',
    availableEndpoints: [
      'GET /health',
      'GET /api/config',
      'GET /api/test',
      'POST /api/create-checkout-session',
      'GET /api/checkout-session/:sessionId',
      'POST /api/webhook',
      'GET /api/metrics'
    ],
    requestId: req.requestId
  });
});

// Graceful shutdown handling
const shutdown = (signal) => {
  console.log(`\n🛑 ${signal} received, starting graceful shutdown...`);
  
  server.close((err) => {
    if (err) {
      console.error('❌ Error during server shutdown:', err);
      process.exit(1);
    }
    
    console.log('✅ Server closed successfully');
    
    // Close database connections, cleanup resources, etc.
    setTimeout(() => {
      console.log('✅ Graceful shutdown completed');
      process.exit(0);
    }, 1000);
  });
  
  // Force shutdown after 30 seconds
  setTimeout(() => {
    console.error('❌ Forced shutdown after 30s timeout');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  console.error('🔥 Uncaught Exception:', {
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  });
  
  if (isProduction) {
    // In production, attempt graceful shutdown
    shutdown('UNCAUGHT_EXCEPTION');
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 Unhandled Rejection:', {
    reason: reason?.message || reason,
    promise,
    timestamp: new Date().toISOString()
  });
  
  if (isProduction) {
    // In production, log but don't crash
    console.error('⚠️ Continuing execution in production mode');
  } else {
    process.exit(1);
  }
});

// Start server
const server = app.listen(PORT, () => {
  console.log('🚀 Stripe Payment Server Started:', {
    port: PORT,
    environment: isProduction ? 'production' : 'development',
    nodeVersion: process.version,
    stripeApiVersion: '2023-10-16',
    timestamp: new Date().toISOString(),
    processId: process.pid
  });
  
  // Test Stripe connection on startup
  stripeClient.accounts.retrieve()
    .then(account => {
      console.log('✅ Stripe connection verified:', {
        accountId: account.id,
        country: account.country,
        chargesEnabled: account.charges_enabled
      });
    })
    .catch(error => {
      console.error('❌ Stripe connection failed on startup:', error.message);
    });
});

// Server timeout and keep-alive settings
server.keepAliveTimeout = 65000; // 65 seconds
server.headersTimeout = 66000; // 66 seconds
server.timeout = 120000; // 2 minutes

module.exports = app;
