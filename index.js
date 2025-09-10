import express from 'express';
import cors from 'cors';
import { createHash, createHmac, createDecipheriv, createCipheriv, randomBytes } from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// WhatsApp API config
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v23.0';

// --- BSP Lead Storage ---
// Simple in-memory storage for BSP leads (resets on server restart)
const bspLeadStore = {
  latest: null,           // Most recent lead
  byPhone: new Map(),     // Map phone -> lead data
  bySession: new Map(),   // Map session/chat_id -> phone
  recent: []              // Array of recent leads (max 100)
};

// [Copy all your existing functions here - storeBspLead, getBspLead, etc.]
// ... (all the functions from your webhook.js file)

// --- Routes ---

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Railway WhatsApp Webhook Server is running!' });
});

// WhatsApp webhook verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken && challenge) {
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: 'Forbidden' });
  }
});

// BSP Lead webhook
app.post('/bsp-lead', async (req, res) => {
  console.log('=== BSP LEAD WEBHOOK ===');
  console.log('Body:', JSON.stringify(req.body, null, 2));
  
  try {
    const leadData = {
      phoneNumber: req.body.phoneNumber || req.body.chat_id,
      firstName: req.body.firstName || req.body.first_name,
      email: req.body.email,
      chatId: req.body.chatId || req.body.chat_id,
      subscriberId: req.body.subscriberId,
      userMessage: req.body.user_message,
      postbackId: req.body.postbackid,
      ...req.body
    };
    
    if (leadData.phoneNumber) {
      const storedLead = storeBspLead(leadData);
      await persistBspLead(storedLead);
      
      return res.status(200).json({
        success: true,
        message: 'Lead received and processed',
        data: {
          id: storedLead.id,
          phoneNumber: storedLead.phoneNumber,
          firstName: storedLead.firstName,
          stored: true
        },
        timestamp: storedLead.timestamp
      });
    } else {
      return res.status(400).json({
        success: false,
        message: 'No phone number provided in lead data'
      });
    }
  } catch (error) {
    console.error('BSP lead processing error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

// WhatsApp Flow webhook (POST)
app.post('/webhook', async (req, res) => {
  try {
    validateEnvironmentVars();
    
    const requestBody = req.body;
    const privateKeyPem = process.env.PRIVATE_KEY;
    const privateKey = await importPrivateKey(privateKeyPem);

    const { decryptedBody, aesKeyBuffer, initialVectorBuffer } = await decryptRequest(requestBody, privateKey);

    let responsePayload;
    if (decryptedBody.action === 'ping') {
      responsePayload = await handleHealthCheck();
    } else if (decryptedBody.action === 'error_notification') {
      responsePayload = await handleErrorNotification(decryptedBody);
    } else {
      responsePayload = await handleDataExchange(decryptedBody);
    }

    const encryptedResponse = await encryptResponse(responsePayload, aesKeyBuffer, initialVectorBuffer);
    
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(encryptedResponse);
  } catch (error) {
    console.error('Error processing request:', error);
    return res.status(500).json({ error: `Internal Server Error: ${error.message}` });
  }
});

// Debug endpoint
app.get('/debug-leads', async (req, res) => {
  const debugInfo = {
    latest: bspLeadStore.latest,
    totalStored: bspLeadStore.byPhone.size,
    recentCount: bspLeadStore.recent.length,
    phoneNumbers: Array.from(bspLeadStore.byPhone.keys()),
    recentLeads: bspLeadStore.recent.slice(0, 5).map(lead => ({
      phone: lead.phoneNumber,
      name: lead.firstName,
      timestamp: lead.timestamp,
      id: lead.id
    }))
  };
  
  return res.status(200).json({
    success: true,
    message: 'BSP Lead Storage Debug Info',
    data: debugInfo,
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Railway WhatsApp Webhook Server running on port ${PORT}`);
  console.log(`📍 Webhook URL: https://your-app.railway.app/webhook`);
  console.log(`📍 BSP Lead URL: https://your-app.railway.app/bsp-lead`);
});

// [Copy all your existing functions below this line]
// validateEnvironmentVars, importPrivateKey, decryptRequest, encryptResponse, 
// decryptWhatsAppImage, uploadGeneratedImageToSupabase, createSimplePrompt,
// generateImageFromAi, sendWhatsAppImageMessage, handleDataExchange, etc.
