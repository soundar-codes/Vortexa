const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({
  origin: ['https://medguardian-92fde.web.app', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Serverless function is running', timestamp: new Date().toISOString() });
});

// Test environment variables endpoint
app.get('/test-env', (req, res) => {
  res.json({
    hasProjectId: !!process.env.FIREBASE_PROJECT_ID,
    hasClientEmail: !!process.env.FIREBASE_CLIENT_EMAIL,
    hasPrivateKey: !!process.env.FIREBASE_PRIVATE_KEY,
    hasJwtSecret: !!process.env.JWT_SECRET,
    projectId: process.env.FIREBASE_PROJECT_ID ? '***' + process.env.FIREBASE_PROJECT_ID.slice(-4) : 'missing'
  });
});

module.exports = app;
