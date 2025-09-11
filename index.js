import express from 'express';
import cors from 'cors';
import { createHash, createHmac, createDecipheriv, createCipheriv, randomBytes } from 'crypto';
import { createClient } from '@supabase/supabase-js';
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
// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// --- BSP Lead Storage ---
// Simple in-memory storage for BSP leads (resets on server restart)
const bspLeadStore = {
  latest: null,           // Most recent lead
  byPhone: new Map(),     // Map phone -> lead data
  bySession: new Map(),   // Map session/chat_id -> phone
  recent: []              // Array of recent leads (max 100)
};

// --- Routes ---

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'Railway WhatsApp Webhook Server is running!',
    endpoints: {
      webhook: '/webhook',
      bspLead: '/bsp-lead', 
      debug: '/debug-leads'
    }
  });
});

// WhatsApp webhook verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken && challenge) {
    console.log('✅ WhatsApp webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    console.log('❌ WhatsApp webhook verification failed');
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
    
    console.log('=== EXTRACTED LEAD DATA ===');
    console.log('Phone Number:', leadData.phoneNumber);
    console.log('First Name:', leadData.firstName);
    console.log('Email:', leadData.email);
    console.log('Chat ID:', leadData.chatId);
    console.log('Subscriber ID:', leadData.subscriberId);
    console.log('User Message:', leadData.userMessage);
    console.log('Postback ID:', leadData.postbackId);
    
    if (leadData.phoneNumber) {
  console.log('✅ LEAD CAPTURED SUCCESSFULLY');
  
  const storedLead = storeBspLead(leadData);
  const supabaseResult = await persistBspLead(storedLead);
  
  return res.status(200).json({
    success: true,
    message: 'Lead received and processed',
    data: {
      id: storedLead.id,
      phoneNumber: storedLead.phoneNumber,
      firstName: storedLead.firstName,
      email: storedLead.email,
      chatId: storedLead.chatId,
      subscriberId: storedLead.subscriberId,
      userMessage: storedLead.userMessage,
      stored: true,
      // Add Supabase info
      supabase: {
        isNewLead: supabaseResult.isNew,
        walletCredits: supabaseResult.lead?.wallet || 0,
        creditsAdded: supabaseResult.walletAdded,
        supabaseId: supabaseResult.lead?.id || null
      }
    },
    timestamp: storedLead.timestamp
  });
} else {
      console.log('❌ No phone number provided');
      return res.status(400).json({
        success: false,
        message: 'No phone number provided in lead data',
        data: leadData
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
    
    // Check if this is a Flow completion message (NOT encrypted Flow data exchange)
    if (requestBody.entry && requestBody.entry[0]?.changes && requestBody.entry[0].changes[0]?.value?.messages) {
      console.log('=== PROCESSING WHATSAPP MESSAGE WEBHOOK (FLOW COMPLETION) ===');
      return await handleWhatsAppMessage(requestBody, res);
    }
    
    // Check if this is encrypted Flow data exchange
    if (requestBody.encrypted_aes_key && requestBody.encrypted_flow_data) {
      console.log('=== PROCESSING ENCRYPTED FLOW DATA EXCHANGE (NAVIGATION ONLY) ===');
      return await handleEncryptedFlowDataExchange(requestBody, res);
    }
    
    // Check if this is a BSP lead (no encryption)
    if (requestBody.phoneNumber || requestBody.firstName || requestBody.chat_id) {
      console.log('=== PROCESSING BSP LEAD ===');
      return await handleBspLeadDirect(req, res);
    }
    
    console.log('Unknown webhook payload type:', JSON.stringify(requestBody, null, 2));
    return res.status(200).json({ status: 'received' });
    
  } catch (error) {
    console.error('Error processing webhook request:', error);
    return res.status(500).json({ error: `Internal Server Error: ${error.message}` });
  }
});

// Debug endpoint
app.get('/debug-leads', async (req, res) => {
  console.log('=== DEBUG LEADS ENDPOINT ===');
  
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
    })),
    sessionMappings: Array.from(bspLeadStore.bySession.entries())
  };
  
  console.log('Debug info:', JSON.stringify(debugInfo, null, 2));
  
  return res.status(200).json({
    success: true,
    message: 'BSP Lead Storage Debug Info',
    data: debugInfo,
    timestamp: new Date().toISOString()
  });
});

// --- All Your Functions Below ---

// Store BSP lead data
function storeBspLead(leadData) {
  const phoneNumber = leadData.phoneNumber || leadData.chat_id;
  const timestamp = new Date().toISOString();
  
  const enrichedLead = {
    ...leadData,
    phoneNumber,
    timestamp,
    id: `${phoneNumber}-${Date.now()}`
  };
  
  // Store as latest
  bspLeadStore.latest = enrichedLead;
  
  // Store by phone number
  if (phoneNumber) {
    bspLeadStore.byPhone.set(phoneNumber, enrichedLead);
    
    // Store session mapping
    if (leadData.chatId || leadData.chat_id) {
      bspLeadStore.bySession.set(leadData.chatId || leadData.chat_id, phoneNumber);
    }
  }
  
  // Add to recent leads (keep only last 100)
  bspLeadStore.recent.unshift(enrichedLead);
  if (bspLeadStore.recent.length > 100) {
    bspLeadStore.recent = bspLeadStore.recent.slice(0, 100);
  }
  
  console.log('📍 BSP Lead stored:', {
    phone: phoneNumber,
    name: leadData.firstName || leadData.first_name,
    totalStored: bspLeadStore.byPhone.size,
    recentCount: bspLeadStore.recent.length
  });
  
  return enrichedLead;
}

// Get BSP lead data
function getBspLead(identifier = 'latest') {
  if (identifier === 'latest') {
    return bspLeadStore.latest;
  }
  
  // Try to get by phone number
  if (bspLeadStore.byPhone.has(identifier)) {
    return bspLeadStore.byPhone.get(identifier);
  }
  
  // Try to get by session/chat_id
  if (bspLeadStore.bySession.has(identifier)) {
    const phone = bspLeadStore.bySession.get(identifier);
    return bspLeadStore.byPhone.get(phone);
  }
  
  return null;
}
// Supabase lead management functions
async function storeLeadInSupabase(leadData) {
  try {
    const phoneNumber = leadData.phoneNumber || leadData.chat_id;
    const firstName = leadData.firstName || leadData.first_name || '';
    
    if (!phoneNumber) {
      throw new Error('Phone number is required');
    }

    // Normalize phone number (remove non-digits and ensure consistent format)
    const normalizedPhone = phoneNumber.replace(/\D/g, '');
    
    console.log('🔍 Checking if lead exists in Supabase:', normalizedPhone);
    
    // Check if lead already exists
    const { data: existingLead, error: selectError } = await supabase
      .from('leads')
      .select('*')
      .eq('number', normalizedPhone)
      .single();
    
    if (selectError && selectError.code !== 'PGRST116') { // PGRST116 = no rows found
      throw selectError;
    }
    
    if (existingLead) {
      console.log('📋 Lead already exists:', {
        id: existingLead.id,
        name: existingLead.name,
        number: existingLead.number,
        wallet: existingLead.wallet
      });
      
      // Update name if it's empty and we have a new name
      if (!existingLead.name && firstName) {
        const { error: updateError } = await supabase
          .from('leads')
          .update({ name: firstName })
          .eq('id', existingLead.id);
          
        if (updateError) {
          console.error('Failed to update lead name:', updateError);
        } else {
          console.log('✅ Updated lead name:', firstName);
        }
      }
      
      return {
        isNew: false,
        lead: existingLead,
        walletAdded: 0
      };
    }
    
    // Create new lead with 3 credits
    console.log('➕ Creating new lead with 3 credits');
    const { data: newLead, error: insertError } = await supabase
      .from('leads')
      .insert({
        name: firstName,
        number: normalizedPhone,
        wallet: 3
      })
      .select()
      .single();
    
    if (insertError) {
      throw insertError;
    }
    
    console.log('✅ New lead created successfully:', {
      id: newLead.id,
      name: newLead.name,
      number: newLead.number,
      wallet: newLead.wallet
    });
    
    return {
      isNew: true,
      lead: newLead,
      walletAdded: 3
    };
    
  } catch (error) {
    console.error('❌ Error storing lead in Supabase:', error);
    throw error;
  }
}

async function getLeadWallet(phoneNumber) {
  try {
    const normalizedPhone = phoneNumber.replace(/\D/g, '');
    
    const { data: lead, error } = await supabase
      .from('leads')
      .select('wallet')
      .eq('number', normalizedPhone)
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') { // No rows found
        return 0;
      }
      throw error;
    }
    
    return lead?.wallet || 0;
  } catch (error) {
    console.error('Error fetching lead wallet:', error);
    return 0;
  }
}

async function updateLeadWallet(phoneNumber, newBalance) {
  try {
    const normalizedPhone = phoneNumber.replace(/\D/g, '');
    
    const { error } = await supabase
      .from('leads')
      .update({ wallet: newBalance })
      .eq('number', normalizedPhone);
    
    if (error) {
      throw error;
    }
    
    console.log(`✅ Wallet updated for ${normalizedPhone}: ${newBalance} credits`);
    return true;
  } catch (error) {
    console.error('Error updating lead wallet:', error);
    return false;
  }
}
// Enhanced credit management functions
async function checkUserCredits(phoneNumber) {
  try {
    const normalizedPhone = phoneNumber.replace(/\D/g, '');
    const credits = await getLeadWallet(normalizedPhone);
    console.log(`💰 User ${normalizedPhone} has ${credits} credits`);
    return credits;
  } catch (error) {
    console.error('Error checking credits:', error);
    return 0;
  }
}

async function deductUserCredits(phoneNumber, amount = 1) {
  try {
    const normalizedPhone = phoneNumber.replace(/\D/g, '');
    const currentCredits = await getLeadWallet(normalizedPhone);
    
    if (currentCredits < amount) {
      throw new Error('Insufficient credits');
    }
    
    const newBalance = currentCredits - amount;
    await updateLeadWallet(normalizedPhone, newBalance);
    
    console.log(`💸 Deducted ${amount} credit from ${normalizedPhone}. New balance: ${newBalance}`);
    return {
      success: true,
      previousBalance: currentCredits,
      newBalance: newBalance,
      deducted: amount
    };
  } catch (error) {
    console.error('Error deducting credits:', error);
    return { success: false, error: error.message };
  }
}
// Optional: Persist to database (implement based on your needs)
// Persist BSP lead to Supabase
async function persistBspLead(leadData) {
  try {
    console.log('💾 Persisting BSP lead to Supabase...');
    
    const result = await storeLeadInSupabase(leadData);
    
    if (result.isNew) {
      console.log('🎉 New lead! 3 credits added to wallet');
    } else {
      console.log('👤 Returning lead - no credits added');
    }
    
    return result;
  } catch (error) {
    console.error('Failed to persist BSP lead:', error);
    return {
      isNew: false,
      lead: null,
      walletAdded: 0,
      error: error.message
    };
  }
}

// Handle BSP lead directly
async function handleBspLeadDirect(req, res) {
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
}
// Handle WhatsApp message webhook
async function handleWhatsAppMessage(requestBody, res) {
  try {
    const messages = requestBody.entry[0]?.changes[0]?.value?.messages || [];
    
    for (const message of messages) {
      console.log('=== WHATSAPP MESSAGE RECEIVED ===');
      console.log('Message type:', message.type);
      console.log('From:', message.from);
      
      // Check if this is a Flow completion message
      if (message.type === 'interactive' && message.interactive?.type === 'nfm_reply') {
        await handleFlowCompletion(message);
      } else {
        console.log('Regular message received:', message.type);
      }
    }
    
    return res.status(200).json({ status: 'received' });
    
  } catch (error) {
    console.error('Error handling WhatsApp message:', error);
    return res.status(500).json({ error: error.message });
  }
}

// Handle Flow completion
async function handleFlowCompletion(message) {
  console.log('=== FLOW COMPLETION DETECTED ===');
  
  try {
    // Extract user phone number from message (100% reliable)
    const userPhone = message.from;
    console.log('✅ Flow completed by user:', userPhone);
    
    // Parse the Flow response data
    const nfmReply = message.interactive.nfm_reply;
    const responseJson = JSON.parse(nfmReply.response_json);
    
    console.log('Flow response data:', JSON.stringify(responseJson, null, 2));
    
    // Extract Flow data
    const {
      status,
      product_category,
      scene_description,
      price_overlay,
      product_image,
      action
    } = responseJson;
    
    // Handle different completion types
    // Handle different completion types
if (action === 'check_balance_completed') {
  const credits = await checkUserCredits(userPhone);
  const balanceMessage = `💰 Your Current Balance: ${credits} credits\n\nEach image generation costs 1 credit. Contact support to recharge when needed.`;
  await sendWhatsAppTextMessage(userPhone, balanceMessage);
  console.log('✅ Balance check completed for:', userPhone);
  return;
}
    
    if (action === 'insufficient_credits') {
      console.log('Insufficient credits flow completed for:', userPhone);
      return; // No further processing needed
    }
    
    // Handle image generation completion
    if (status === 'processing' && product_image && product_category) {
      console.log('=== PROCESSING IMAGE GENERATION FROM FLOW COMPLETION ===');
      
      // Check user credits
      const credits = await checkUserCredits(userPhone);
      if (credits < 1) {
        await sendWhatsAppTextMessage(userPhone, 
          `❌ Insufficient credits. You have ${credits} credits. Each image generation requires 1 credit.`);
        return;
      }
      
      // Process the image
      await generateImageFromFlowCompletion(
        userPhone,
        product_image,
        product_category,
        scene_description,
        price_overlay
      );
    }
    
  } catch (error) {
    console.error('❌ Error processing Flow completion:', error);
    
    if (message.from) {
      try {
        await sendWhatsAppTextMessage(message.from, 
          "❌ An error occurred processing your request. Please try again.");
      } catch (sendError) {
        console.error('Failed to send error message:', sendError);
      }
    }
  }
}

// Generate image from Flow completion
async function generateImageFromFlowCompletion(userPhone, productImageData, productCategory, sceneDescription = null, priceOverlay = null) {
  console.log('=== GENERATING IMAGE FROM FLOW COMPLETION ===');
  console.log('User Phone:', userPhone);
  console.log('Product Category:', productCategory);
  
  try {
    // Process the product image data
    let actualImageData;
    
    if (Array.isArray(productImageData) && productImageData.length > 0) {
      const firstImage = productImageData[0];
      
      if (firstImage.encryption_metadata) {
        actualImageData = await decryptWhatsAppImage(firstImage);
      } else if (firstImage.cdn_url) {
        const response = await fetch(firstImage.cdn_url);
        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        actualImageData = Buffer.from(arrayBuffer).toString('base64');
      } else {
        throw new Error('Invalid image format');
      }
    } else if (typeof productImageData === 'string') {
      actualImageData = productImageData;
    } else {
      throw new Error('Invalid product_image format');
    }
    
    // Generate the enhanced image
    const imageUrl = await generateImageFromAi(
      actualImageData,
      productCategory,
      sceneDescription,
      priceOverlay
    );
    
    // Get user info for personalized message
    const leadInfo = getBspLead(userPhone) || { firstName: null };
    const caption = createImageCaption(productCategory, priceOverlay, leadInfo);
    
    // Send the image
    await sendWhatsAppImageMessage(userPhone, imageUrl, caption);
    
    // Deduct credit and send balance update
    const deductionResult = await deductUserCredits(userPhone, 1);
    if (deductionResult.success) {
      const balanceMessage = `✅ Image generated successfully!\n\n💰 1 credit used. Remaining balance: ${deductionResult.newBalance} credits`;
      await sendWhatsAppTextMessage(userPhone, balanceMessage);
    }
    
    console.log('✅ Image generation and delivery completed for:', userPhone);
    
  } catch (error) {
    console.error('❌ Image generation failed:', error);
    await sendWhatsAppTextMessage(userPhone, 
      "❌ Image generation failed. Please try again. Your credits have not been deducted.");
  }
}

// Handle encrypted Flow data exchange
async function handleEncryptedFlowDataExchange(requestBody, res) {
  console.log('=== HANDLING ENCRYPTED FLOW DATA EXCHANGE (NAVIGATION ONLY) ===');
  
  try {
    const privateKeyPem = process.env.PRIVATE_KEY;
    const privateKey = await importPrivateKey(privateKeyPem);

    const { decryptedBody, aesKeyBuffer, initialVectorBuffer } = await decryptRequest(requestBody, privateKey);

    let responsePayload;
    
    if (decryptedBody.action === 'ping') {
      responsePayload = await handleHealthCheck();
    } else if (decryptedBody.action === 'error_notification') {
      responsePayload = await handleErrorNotification(decryptedBody);
    } else {
      // Handle Flow interactions (NO image generation here)
      responsePayload = await handleFlowNavigationOnly(decryptedBody);
    }

    const encryptedResponse = await encryptResponse(responsePayload, aesKeyBuffer, initialVectorBuffer);
    
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(encryptedResponse);
    
  } catch (error) {
    console.error('Error processing encrypted Flow data exchange:', error);
    return res.status(500).json({ error: `Internal Server Error: ${error.message}` });
  }
}
// Enhanced WhatsApp Phone Number Detection
function getUserPhoneFromPayload(decryptedBody) {
  console.log('=== PHONE NUMBER DETECTION ===');
  
  // Method 1: Extract from WhatsApp Flow payload
  const flowCandidates = [
    decryptedBody?.user?.wa_id,
    decryptedBody?.user?.phone,
    decryptedBody?.phone_number,
    decryptedBody?.mobile_number,
    decryptedBody?.data?.phone_number,
    decryptedBody?.data?.user_phone,
    decryptedBody?.data?.mobile_number
  ];

  const flowPhone = flowCandidates.find((v) => typeof v === 'string' && v.trim().length > 0);
  
  if (flowPhone) {
    const digits = flowPhone.replace(/\D/g, '');
    if (digits) {
      const normalizedPhone = digits.length === 10 ? `91${digits}` : digits;
      console.log('📱 Phone from WhatsApp Flow:', normalizedPhone);
      return normalizedPhone;
    }
  }

  // Method 2: Get from latest BSP lead
  const latestLead = getBspLead('latest');
  if (latestLead?.phoneNumber) {
    const digits = latestLead.phoneNumber.replace(/\D/g, '');
    if (digits) {
      const normalizedPhone = digits.length === 10 ? `91${digits}` : digits;
      console.log('📱 Phone from latest BSP lead:', normalizedPhone, `(${latestLead.firstName || 'Unknown'})`);
      return normalizedPhone;
    }
  }

  console.log('❌ No phone number found in payload or BSP leads');
  return null;
}

// Enhanced Image Generation with BSP Integration
async function generateImageAndSendToUser(decryptedBody, actualImageData, productCategory, sceneDescription, priceOverlay) {
  console.log('🚀 Starting image generation and user notification...');
  
  try {
    // Generate the image
    const imageUrl = await generateImageFromAi(
      actualImageData,
      productCategory.trim(),
      sceneDescription && sceneDescription.trim() ? sceneDescription.trim() : null,
      priceOverlay && priceOverlay.trim() ? priceOverlay.trim() : null
    );
    
    console.log('✅ Image generation successful:', imageUrl);

    // Get user's phone number (from Flow payload or BSP lead)
    const toPhone = getUserPhoneFromPayload(decryptedBody);
    
    if (!toPhone) {
      console.warn('⚠️ Phone number not found; cannot send WhatsApp message');
      console.log('Available BSP leads:', {
        latest: bspLeadStore.latest?.phoneNumber || 'none',
        totalStored: bspLeadStore.byPhone.size,
        recent: bspLeadStore.recent.slice(0, 3).map(lead => ({ 
          phone: lead.phoneNumber, 
          name: lead.firstName 
        }))
      });
    } else {
      // Get lead info for personalized message
      const leadInfo = getBspLead(toPhone) || getBspLead('latest');
      
      const caption = createImageCaption(productCategory, priceOverlay, leadInfo);
      
      console.log('📤 Sending WhatsApp image to:', toPhone);
      console.log('📝 Caption:', caption);
      
      try {
        const waResp = await sendWhatsAppImageMessage(toPhone, imageUrl, caption);
        console.log('✅ WhatsApp image sent successfully:', JSON.stringify(waResp));
      } catch (sendErr) {
        console.error('❌ Failed to send WhatsApp image:', sendErr);
      }
    }

    return imageUrl;
  } catch (error) {
    console.error('❌ Image generation or sending failed:', error);
    throw error;
  }
}

// Create personalized image caption
function createImageCaption(productCategory, priceOverlay, leadInfo) {
  let caption = '';
  
  // Personalized greeting if we have lead info
  if (leadInfo?.firstName) {
    caption += `Hi ${leadInfo.firstName}! `;
  }
  
  // Product info
  caption += `Here's your enhanced ${productCategory}`;
  
  // Price if provided
  if (priceOverlay && priceOverlay.trim()) {
    caption += ` — ${priceOverlay.trim()}`;
  }
  
  caption += ' image! 🎨✨';
  
  return caption;
}

// Utility Functions
function validateEnvironmentVars() {
  const requiredVars = [
    'PRIVATE_KEY',
    'VERIFY_TOKEN',
    'SUPABASE_URL',
    'GEMINI_API_KEY',
    'SUPABASE_S3_ENDPOINT',
    'SUPABASE_S3_ACCESS_KEY_ID',
    'SUPABASE_S3_SECRET_ACCESS_KEY',
    'WHATSAPP_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID'
  ];
  const missing = requiredVars.filter((varName) => !process.env[varName]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

async function importPrivateKey(privateKeyPem) {
  const { webcrypto } = await import('crypto');
  const crypto = webcrypto;
  
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = privateKeyPem.replace(pemHeader, "").replace(pemFooter, "").replace(/\s/g, "");
  const binaryDer = Uint8Array.from(Buffer.from(pemContents, 'base64'));
  
  return await crypto.subtle.importKey("pkcs8", binaryDer, {
    name: "RSA-OAEP",
    hash: "SHA-256"
  }, false, ["decrypt"]);
}

// Encryption/Decryption Functions
async function decryptRequest(body, privateKey) {
  const { webcrypto } = await import('crypto');
  const crypto = webcrypto;
  
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;
  if (!encrypted_aes_key || !encrypted_flow_data || !initial_vector) {
    throw new Error('Missing encrypted data fields in the request body');
  }

  try {
    const encryptedAesKeyBuffer = Buffer.from(encrypted_aes_key, 'base64');
    const aesKeyBuffer = new Uint8Array(await crypto.subtle.decrypt({
      name: "RSA-OAEP"
    }, privateKey, encryptedAesKeyBuffer));

    const flowDataBuffer = Buffer.from(encrypted_flow_data, 'base64');
    const initialVectorBuffer = Buffer.from(initial_vector, 'base64');

    const aesKey = await crypto.subtle.importKey("raw", aesKeyBuffer, {
      name: "AES-GCM"
    }, false, ["decrypt"]);

    const decryptedBuffer = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: initialVectorBuffer,
      tagLength: 128
    }, aesKey, flowDataBuffer);

    const decryptedJSONString = new TextDecoder().decode(decryptedBuffer);
    const decryptedBody = JSON.parse(decryptedJSONString);

    return {
      decryptedBody,
      aesKeyBuffer,
      initialVectorBuffer
    };
  } catch (error) {
    console.error('Decryption failed:', error);
    throw new Error(`Decryption failed: ${error.message}`);
  }
}

async function encryptResponse(response, aesKeyBuffer, initialVectorBuffer) {
  const { webcrypto } = await import('crypto');
  const crypto = webcrypto;
  
  try {
    const flippedIv = new Uint8Array(initialVectorBuffer.map((byte) => ~byte & 0xFF));

    const aesKey = await crypto.subtle.importKey("raw", aesKeyBuffer, {
      name: "AES-GCM"
    }, false, ["encrypt"]);

    const responseString = JSON.stringify(response);
    const responseBuffer = new TextEncoder().encode(responseString);

    const encryptedBuffer = await crypto.subtle.encrypt({
      name: "AES-GCM",
      iv: flippedIv,
      tagLength: 128
    }, aesKey, responseBuffer);

    const encryptedUint8Array = new Uint8Array(encryptedBuffer);
    return Buffer.from(encryptedUint8Array).toString('base64');
  } catch (error) {
    console.error('Encryption failed:', error);
    throw new Error(`Encryption failed: ${error.message}`);
  }
}

// WhatsApp Image Decryption (CBC + HMAC 10-byte trailer, HMAC over iv|ciphertext)
async function decryptWhatsAppImage(imageData) {
  console.log('=== DECRYPT WHATSAPP IMAGE (CBC+HMAC-10) ===');
  console.log('Image data:', JSON.stringify(imageData, null, 2));

  try {
    const { cdn_url, encryption_metadata } = imageData;
    if (!cdn_url || !encryption_metadata) {
      throw new Error('Missing cdn_url or encryption_metadata');
    }

    const { encryption_key, hmac_key, iv, encrypted_hash, plaintext_hash } = encryption_metadata;

    const keyBuf = Buffer.from(encryption_key, 'base64'); // 32
    const macKeyBuf = Buffer.from(hmac_key, 'base64');    // 32
    const ivBuf = Buffer.from(iv, 'base64');              // 16

    if (keyBuf.length !== 32) throw new Error('Invalid encryption_key length');
    if (macKeyBuf.length !== 32) throw new Error('Invalid hmac_key length');
    if (ivBuf.length !== 16) throw new Error('Invalid iv length');

    console.log('Fetching encrypted image from CDN:', cdn_url);
    const response = await fetch(cdn_url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image from CDN: ${response.status}`);
    }

    const encBuf = Buffer.from(await response.arrayBuffer());
    console.log('Encrypted image size:', encBuf.byteLength);

    if (encBuf.length <= 10) {
      throw new Error('Encrypted payload too small');
    }

    if (encrypted_hash) {
      const encSha = createHash('sha256').update(encBuf).digest('base64');
      console.log('Encrypted SHA256 (computed vs provided):', encSha, encrypted_hash);
      if (encSha !== encrypted_hash) {
        throw new Error('Encrypted hash mismatch');
      }
    }

    // Split ciphertext and appended MAC (last 10 bytes)
    const macTrailer = encBuf.subarray(encBuf.length - 10);
    const cipherText = encBuf.subarray(0, encBuf.length - 10);

    // HMAC-SHA256(iv || ciphertext), compare first 10 bytes
    const macFull = createHmac('sha256', macKeyBuf).update(ivBuf).update(cipherText).digest();
    const mac10 = macFull.subarray(0, 10);

    if (!mac10.equals(macTrailer)) {
      throw new Error('HMAC verification failed');
    }

    if (cipherText.length % 16 !== 0) {
      throw new Error(`Ciphertext length not a multiple of 16: ${cipherText.length}`);
    }

    // Decrypt AES-256-CBC with PKCS#7 padding
    let decrypted;
    try {
      const decipher = createDecipheriv('aes-256-cbc', keyBuf, ivBuf);
      decipher.setAutoPadding(true);
      decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    } catch (e) {
      throw new Error(`AES decryption failed: ${e.message}`);
    }

    if (plaintext_hash) {
      const plainSha = createHash('sha256').update(decrypted).digest('base64');
      if (plainSha !== plaintext_hash) {
        console.warn('Plaintext hash mismatch (computed vs provided):', plainSha, plaintext_hash);
      } else {
        console.log('Plaintext hash verified.');
      }
    }

    console.log('Decryption successful. Size:', decrypted.length);
    return decrypted.toString('base64');
  } catch (error) {
    console.error('Error decrypting WhatsApp image:', error);
    throw new Error(`Image decryption failed: ${error.message}`);
  }
}

// Upload to Supabase Storage via S3-compatible API (SigV4)
async function uploadGeneratedImageToSupabase(base64Data, mimeType) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const s3Endpoint = process.env.SUPABASE_S3_ENDPOINT; // e.g. https://<ref>.storage.supabase.co/storage/v1/s3
  const s3Region = process.env.SUPABASE_S3_REGION || 'us-east-1';
  const accessKeyId = process.env.SUPABASE_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SUPABASE_S3_SECRET_ACCESS_KEY;
  const bucket = process.env.SUPABASE_S3_BUCKET || 'generated-images';

  if (!supabaseUrl || !s3Endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing SUPABASE_URL, SUPABASE_S3_ENDPOINT, or S3 credentials');
  }

  const buffer = Buffer.from(base64Data, 'base64');
  const ext = (mimeType && mimeType.split('/')[1]) || 'jpg';
  const filename = `generated-${Date.now()}.${ext}`;

  const s3 = new S3Client({
    region: s3Region,
    endpoint: s3Endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true
  });

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: filename,
    Body: buffer,
    ContentType: mimeType || 'image/jpeg'
  }));

  const baseUrl = supabaseUrl.replace(/\/+$/, '');
  const publicUrl = `${baseUrl}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodeURIComponent(filename)}`;
  console.log('Generated image uploaded (S3):', publicUrl);
  return publicUrl;
}

// Simple prompt creation function
function createSimplePrompt(productCategory, sceneDescription = null, priceOverlay = null) {
  let prompt = `Create a professional product photo of this ${productCategory}.`;
  
  if (sceneDescription && sceneDescription.trim()) {
    prompt += ` Show it in this setting: ${sceneDescription}.`;
  } else {
    prompt += ` Use a clean, professional background that complements the product.`;
  }
  
  if (priceOverlay && priceOverlay.trim()) {
    prompt += ` Include the price "${priceOverlay}" as a stylish overlay on the image.`;
  }
  
  prompt += ` Make it look like a high-quality commercial product photo suitable for marketing and sales.`;
  
  return prompt;
}

// Simplified Gemini API call
async function generateImageFromAi(productImageBase64, productCategory, sceneDescription = null, priceOverlay = null) {
  console.log('=== GENERATE IMAGE FROM AI ===');
  console.log('Parameters:');
  console.log('- productImageBase64 length:', productImageBase64 ? productImageBase64.length : 0);
  console.log('- productCategory:', productCategory || 'MISSING');
  console.log('- sceneDescription:', sceneDescription || 'not provided');
  console.log('- priceOverlay:', priceOverlay || 'not provided');
  
  if (!productImageBase64 || typeof productImageBase64 !== 'string') {
    throw new Error("Product image data is missing or invalid");
  }
  
  if (!productCategory || typeof productCategory !== 'string') {
    throw new Error("Product category is required");
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY environment variable");
  }

  console.log("Step 1: Cleaning base64 data...");
  
  let cleanBase64 = productImageBase64;
  if (productImageBase64.startsWith('data:')) {
    const base64Index = productImageBase64.indexOf(',');
    if (base64Index !== -1) {
      cleanBase64 = productImageBase64.substring(base64Index + 1);
      console.log("✅ Data URL prefix removed, new length:", cleanBase64.length);
    }
  }

  console.log("Step 2: Creating simple prompt...");
  
  const simplePrompt = createSimplePrompt(productCategory, sceneDescription, priceOverlay);
  console.log("Simple prompt:", simplePrompt);

  console.log("Step 3: Sending to Gemini API...");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: [
      {
        parts: [
          { text: simplePrompt },
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: cleanBase64
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.8,
      maxOutputTokens: 1024,
      topP: 0.9,
      topK: 40
    }
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });

    console.log("Response status:", response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Gemini API error response:", errorText);
      throw new Error(`Gemini API failed (${response.status}): ${errorText}`);
    }

    const responseData = await response.json();
    console.log("✅ Gemini API response received");

    const candidate = responseData?.candidates?.[0];
    if (!candidate?.content?.parts) {
      throw new Error("No response parts found in Gemini API response");
    }

    console.log("Step 4: Processing generated image...");

    for (const part of candidate.content.parts) {
      if (part.inlineData) {
        const generatedMimeType = part.inlineData.mimeType;
        const generatedBase64 = part.inlineData.data;
        console.log("✅ Image generated successfully");
        
        console.log("Step 5: Uploading generated image to Supabase (S3)...");
        try {
          const publicUrl = await uploadGeneratedImageToSupabase(generatedBase64, generatedMimeType);
          console.log("✅ Generated image uploaded to Supabase:", publicUrl);
          return publicUrl;
        } catch (uploadError) {
          console.error("Failed to upload generated image:", uploadError);
          console.log("⚠️ Fallback: returning base64 data URL");
          return `data:${generatedMimeType};base64,${generatedBase64}`;
        }
      }
    }

    const textPart = candidate.content.parts.find((p) => p.text);
    if (textPart) {
      throw new Error(`Model returned text instead of image: ${textPart.text}`);
    }

    throw new Error("No image data found in Gemini API response");
  } catch (error) {
    console.error('❌ Error in generateImageFromAi:', error);
    throw error;
  }
}

async function sendWhatsAppImageMessage(toE164, imageUrl, caption) {
  if (!toE164) throw new Error('Missing recipient phone number (E.164 format)');
  if (!imageUrl) throw new Error('Missing image URL');

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toE164,
      type: 'image',
      image: {
        link: imageUrl,
        caption: caption || ''
      }
    })
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`WhatsApp send failed ${resp.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function sendWhatsAppTextMessage(toE164, message) {
  if (!toE164) throw new Error('Missing recipient phone number (E.164 format)');
  if (!message) throw new Error('Missing message text');

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toE164,
      type: 'text',
      text: {
        body: message
      }
    })
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`WhatsApp send failed ${resp.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// Request Handlers
async function handleFlowNavigationOnly(decryptedBody) {
  const { action, screen, data } = decryptedBody;
  console.log(`Flow navigation: ${action} for screen: ${screen}`);
  console.log('Received data:', JSON.stringify(data, null, 2));
  
  if (action === 'INIT') {
    return { screen: 'OPTION_SELECTION', data: {} };
  }

  if (action === 'data_exchange') {
    console.log('Processing data_exchange action');
    
    // Handle option selection
    if (data?.selected_option) {
      console.log('Selected option:', data.selected_option);
      
      if (data.selected_option === 'check_balance') {
        console.log('Navigating to CHECK_BALANCE');
        return {
          screen: 'CHECK_BALANCE',
          data: {}
        };
      }
      
      if (data.selected_option === 'generate_image') {
        console.log('Navigating to COLLECT_INFO');
        return { screen: 'COLLECT_INFO', data: {} };
      }
    }
    
    // Handle product info collection completion
    if (data?.action === 'collect_info_completed') {
      console.log('Product info collected, navigating to scene collection');
      console.log('Passing data:', {
        product_image: data.product_image ? 'image data present' : 'missing',
        product_category: data.product_category
      });
      
      return {
        screen: 'COLLECT_IMAGE_SCENE',
        data: {
          product_image: data.product_image,
          product_category: data.product_category
        }
      };
    }
    
    // Handle scene info collection completion
    if (data?.action === 'scene_info_completed') {
      console.log('Scene info collected, navigating to success screen');
      console.log('Final data for success screen:', {
        product_image: data.product_image ? 'image data present' : 'missing',
        product_category: data.product_category,
        scene_description: data.scene_description,
        price_overlay: data.price_overlay
      });
      
      return {
        screen: 'SUCCESS_SCREEN',
        data: {
          product_image: data.product_image,
          product_category: data.product_category,
          scene_description: data.scene_description,
          price_overlay: data.price_overlay,
          message: "Your enhanced product image is being generated!"
        }
      };
    }

    console.log('No matching data_exchange action found');
    return { screen: 'OPTION_SELECTION', data: {} };
  }

  if (action === 'BACK') {
    if (screen === 'COLLECT_IMAGE_SCENE') {
      return { screen: 'COLLECT_INFO', data: {} };
    }
    return { screen: 'OPTION_SELECTION', data: {} };
  }

  console.log('Unhandled action:', action);
  return { screen: 'OPTION_SELECTION', data: {} };
}
async function handleHealthCheck() {
  return { data: { status: 'active' } };
}

async function handleErrorNotification(decryptedBody) {
  console.log('Error notification received:', decryptedBody);
  return { data: { acknowledged: true } };
}
// Start server
app.listen(PORT, () => {
  console.log(`🚀 Railway WhatsApp Webhook Server running on port ${PORT}`);
  console.log(`📍 Webhook URL: https://your-app.railway.app/webhook`);
  console.log(`📍 BSP Lead URL: https://your-app.railway.app/bsp-lead`);
  console.log(`📍 Debug URL: https://your-app.railway.app/debug-leads`);
});
