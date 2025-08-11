const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, param, validationResult } = require('express-validator');
const winston = require('winston');
const { BankrClient } = require('@bankr/sdk');
require('dotenv').config();

// Initialize logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Validate required environment variables
const requiredEnvVars = ['BANKR_API_KEY', 'PRIVATE_KEY', 'WALLET_ADDRESS'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  logger.error('Missing required environment variables:', { missingEnvVars });
  process.exit(1);
}

// Initialize Bankr client
let bankrClient;
try {
  bankrClient = new BankrClient({
    apiKey: process.env.BANKR_API_KEY,
    privateKey: process.env.PRIVATE_KEY,
    walletAddress: process.env.WALLET_ADDRESS,
    network: 'base'
  });
  logger.info('Bankr client initialized successfully');
} catch (error) {
  logger.error('Failed to initialize Bankr client:', { error: error.message });
  process.exit(1);
}

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// Security middleware
app.use(helmet());

// CORS configuration
const corsOptions = {
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
};
app.use(cors(corsOptions));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests, please try again later',
      details: 'Rate limit exceeded. Please wait before making more requests.'
    },
    timestamp: new Date().toISOString()
  },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

// Body parser middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  logger.info('Incoming request', {
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  next();
});

// Validation middleware
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: errors.array()
      },
      timestamp: new Date().toISOString()
    });
  }
  next();
};

// Helper function to format error responses
const formatErrorResponse = (code, message, details = null) => ({
  success: false,
  error: {
    code,
    message,
    details
  },
  timestamp: new Date().toISOString()
});

// Helper function to truncate wallet address for logging
const truncateAddress = (address) => {
  if (!address) return null;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

// Routes

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    // Test Bankr connection by checking allowance
    const allowance = await bankrClient.checkAllowance('0x4a15fc613c713FC52E907a77071Ec2d0a392a584');
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      bankrConnection: 'connected',
      allowance: allowance.toString()
    });
  } catch (error) {
    logger.error('Health check failed:', { error: error.message });
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      bankrConnection: 'disconnected',
      error: error.message
    });
  }
});

// Send prompt endpoint
app.post('/api/prompt', [
  body('prompt')
    .isString()
    .isLength({ min: 1, max: 10000 })
    .withMessage('Prompt must be a string between 1 and 10000 characters'),
  body('walletAddress')
    .optional()
    .isEthereumAddress()
    .withMessage('Invalid Ethereum address format'),
  body('xmtp')
    .optional()
    .isBoolean()
    .withMessage('xmtp must be a boolean value')
], handleValidationErrors, async (req, res) => {
  try {
    const { prompt, walletAddress, xmtp = false } = req.body;
    
    logger.info('Prompt request received', {
      promptLength: prompt.length,
      walletAddress: truncateAddress(walletAddress),
      xmtp
    });

    const response = await bankrClient.prompt({
      prompt,
      walletAddress,
      xmtp
    });

    logger.info('Prompt submitted successfully', {
      jobId: response.jobId,
      status: response.status
    });

    res.json(response);
  } catch (error) {
    logger.error('Prompt submission failed:', { error: error.message });
    
    if (error.message.includes('402')) {
      return res.status(402).json(formatErrorResponse(
        'PAYMENT_REQUIRED',
        'Payment required for this request',
        'Ensure you have sufficient $BNKR tokens and proper allowance set'
      ));
    }
    
    if (error.message.includes('401')) {
      return res.status(401).json(formatErrorResponse(
        'UNAUTHORIZED',
        'Invalid API key',
        'Check your Bankr API key configuration'
      ));
    }
    
    res.status(500).json(formatErrorResponse(
      'INTERNAL_ERROR',
      'Failed to submit prompt',
      error.message
    ));
  }
});

// Get job status endpoint
app.get('/api/job/:jobId', [
  param('jobId')
    .isString()
    .isLength({ min: 1, max: 100 })
    .withMessage('Job ID must be a valid string')
], handleValidationErrors, async (req, res) => {
  try {
    const { jobId } = req.params;
    
    logger.info('Job status request', { jobId });

    const status = await bankrClient.getJobStatus(jobId);

    logger.info('Job status retrieved', {
      jobId,
      status: status.status
    });

    res.json(status);
  } catch (error) {
    logger.error('Failed to get job status:', { 
      jobId: req.params.jobId,
      error: error.message 
    });
    
    if (error.message.includes('404')) {
      return res.status(404).json(formatErrorResponse(
        'JOB_NOT_FOUND',
        'Job not found',
        'The specified job ID does not exist'
      ));
    }
    
    res.status(500).json(formatErrorResponse(
      'INTERNAL_ERROR',
      'Failed to retrieve job status',
      error.message
    ));
  }
});

// Prompt and wait endpoint
app.post('/api/prompt-and-wait', [
  body('prompt')
    .isString()
    .isLength({ min: 1, max: 10000 })
    .withMessage('Prompt must be a string between 1 and 10000 characters'),
  body('walletAddress')
    .optional()
    .isEthereumAddress()
    .withMessage('Invalid Ethereum address format'),
  body('xmtp')
    .optional()
    .isBoolean()
    .withMessage('xmtp must be a boolean value'),
  body('timeout')
    .optional()
    .isInt({ min: 1000, max: 300000 })
    .withMessage('Timeout must be between 1000ms and 300000ms (5 minutes)'),
  body('interval')
    .optional()
    .isInt({ min: 1000, max: 10000 })
    .withMessage('Interval must be between 1000ms and 10000ms')
], handleValidationErrors, async (req, res) => {
  try {
    const { 
      prompt, 
      walletAddress, 
      xmtp = false, 
      timeout = 300000, 
      interval = 2000 
    } = req.body;
    
    logger.info('Prompt and wait request received', {
      promptLength: prompt.length,
      walletAddress: truncateAddress(walletAddress),
      xmtp,
      timeout,
      interval
    });

    const result = await bankrClient.promptAndWait({
      prompt,
      walletAddress,
      xmtp,
      timeout,
      interval,
      maxAttempts: Math.floor(timeout / interval)
    });

    logger.info('Prompt and wait completed', {
      jobId: result.jobId,
      status: result.status,
      processingTime: result.processingTime
    });

    res.json(result);
  } catch (error) {
    logger.error('Prompt and wait failed:', { error: error.message });
    
    if (error.message.includes('timeout')) {
      return res.status(408).json(formatErrorResponse(
        'REQUEST_TIMEOUT',
        'Request timed out',
        'The request took longer than the specified timeout period'
      ));
    }
    
    if (error.message.includes('402')) {
      return res.status(402).json(formatErrorResponse(
        'PAYMENT_REQUIRED',
        'Payment required for this request',
        'Ensure you have sufficient $BNKR tokens and proper allowance set'
      ));
    }
    
    res.status(500).json(formatErrorResponse(
      'INTERNAL_ERROR',
      'Failed to process prompt and wait request',
      error.message
    ));
  }
});

// Get allowance endpoint
app.get('/api/allowance', async (req, res) => {
  try {
    const facilitatorAddress = '0x4a15fc613c713FC52E907a77071Ec2d0a392a584';
    const allowance = await bankrClient.checkAllowance(facilitatorAddress);
    
    logger.info('Allowance checked', {
      facilitatorAddress,
      allowance: allowance.toString()
    });

    res.json({
      success: true,
      allowance: allowance.toString(),
      facilitatorAddress,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to check allowance:', { error: error.message });
    
    res.status(500).json(formatErrorResponse(
      'INTERNAL_ERROR',
      'Failed to check allowance',
      error.message
    ));
  }
});

// Approve tokens endpoint
app.post('/api/approve', [
  body('amount')
    .optional()
    .isString()
    .withMessage('Amount must be a string representation of a number')
], handleValidationErrors, async (req, res) => {
  try {
    const facilitatorAddress = '0x4a15fc613c713FC52E907a77071Ec2d0a392a584';
    const amount = req.body.amount || '115792089237316195423570985008687907853269984665640564039457584007913129639935'; // max uint256
    
    logger.info('Token approval request', {
      facilitatorAddress,
      amount
    });

    const approvalTx = await bankrClient.approve(facilitatorAddress, amount);
    
    logger.info('Token approval submitted', {
      transactionHash: approvalTx
    });

    res.json({
      success: true,
      transactionHash: approvalTx,
      facilitatorAddress,
      amount,
      message: 'Approval transaction submitted successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Token approval failed:', { error: error.message });
    
    res.status(500).json(formatErrorResponse(
      'INTERNAL_ERROR',
      'Failed to approve tokens',
      error.message
    ));
  }
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json(formatErrorResponse(
    'NOT_FOUND',
    'Endpoint not found',
    `The requested endpoint ${req.method} ${req.originalUrl} does not exist`
  ));
});

// Global error handler
app.use((error, req, res, next) => {
  logger.error('Unhandled error:', {
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method
  });

  res.status(500).json(formatErrorResponse(
    'INTERNAL_ERROR',
    'An unexpected error occurred',
    process.env.NODE_ENV === 'development' ? error.message : 'Please try again later'
  ));
});

// Start server
app.listen(port, '0.0.0.0', () => {
  logger.info('Server started successfully', {
    port,
    nodeEnv: process.env.NODE_ENV,
    corsOrigin: process.env.CORS_ORIGIN
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

module.exports = app;

