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
    
    // Replace the existing flow sending logic in your BSP lead handler with this:

if (leadData.phoneNumber) {
  console.log('✅ LEAD CAPTURED SUCCESSFULLY');
  
  const storedLead = storeBspLead(leadData);
  const supabaseResult = await persistBspLead(storedLead);
  
  // Send Flow message with user phone embedded - ALWAYS send for new leads
  console.log('🚀 Attempting to send Flow message to user with embedded phone number');
  console.log('User Message:', leadData.userMessage);
  console.log('Flow ID from env:', process.env.WHATSAPP_FLOW_ID);
  
  // Update this part in your BSP lead handler:

try {
  const flowId = process.env.WHATSAPP_FLOW_ID;
  
  if (!flowId) {
    throw new Error('WHATSAPP_FLOW_ID environment variable is not set');
  }
  
  console.log('Sending Flow with parameters:', {
    phone: leadData.phoneNumber,
    flowId: flowId,
    firstName: leadData.firstName
  });
  
  const flowResponse = await sendWhatsAppFlowMessage(
    leadData.phoneNumber, 
    flowId, 
    leadData.firstName  // Removed flowToken parameter
  );
  
  console.log('✅ Flow message sent successfully:', JSON.stringify(flowResponse, null, 2));
} catch (flowError) {
  console.error('❌ Failed to send Flow message:', {
    error: flowError.message,
    stack: flowError.stack,
    leadData: {
      phone: leadData.phoneNumber,
      name: leadData.firstName,
      message: leadData.userMessage
    },
    envVars: {
      hasFlowId: !!process.env.WHATSAPP_FLOW_ID,
      hasToken: !!process.env.WHATSAPP_TOKEN,
      hasPhoneId: !!process.env.WHATSAPP_PHONE_NUMBER_ID
    }
  });
}
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
      flowSent: true, // You can track this based on success/failure
      supabase: {
        isNewLead: supabaseResult.isNew,
        walletCredits: supabaseResult.lead?.wallet || 0,
        creditsAdded: supabaseResult.walletAdded,
        supabaseId: supabaseResult.lead?.id || null
      }
    },
    timestamp: storedLead.timestamp
  });
}else {
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
// WhatsApp Flow webhook (POST)
app.post('/webhook', async (req, res) => {
  try {
    validateEnvironmentVars();
    
    // Handle WhatsApp button responses (for Yes/No follow-up)
    if (req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
      const message = req.body.entry[0].changes[0].value.messages[0];
      const from = message.from;
      
      // Handle button reply
      if (message.type === 'interactive' && message.interactive?.type === 'button_reply') {
        const buttonId = message.interactive.button_reply.id;
        
        console.log('📱 Button response received:', {
          from: from,
          buttonId: buttonId
        });
        
        if (buttonId === 'generate_another_yes') {
          console.log('✅ User wants to generate another image - sending Flow');
          
          // Get user info
          const leadInfo = getBspLead(from);
          const userName = leadInfo?.firstName || 'there';
          const flowId = process.env.WHATSAPP_FLOW_ID;
          
          if (!flowId) {
            console.error('❌ WHATSAPP_FLOW_ID not configured');
            await sendWhatsAppTextMessage(from, "Sorry, the image generator is temporarily unavailable. Please try again later.");
          } else {
            try {
              await sendWhatsAppFlowMessage(from, flowId, userName);
              console.log('✅ New Flow sent for another image generation');
            } catch (flowError) {
              console.error('❌ Failed to send new Flow:', flowError);
              await sendWhatsAppTextMessage(from, "Sorry, there was an issue starting the image generator. Please try again later.");
            }
          }
        } else if (buttonId === 'generate_another_no') {
          console.log('👋 User declined to generate another image - sending thank you');
          
          const leadInfo = getBspLead(from);
          const userName = leadInfo?.firstName || '';
          const thankYouMessage = `Thank you${userName ? ` ${userName}` : ''} for using our AI Image Generator! 🎨\n\nWe hope you loved your enhanced product images. Feel free to return anytime to create more stunning visuals for your products!`;
          
          try {
            await sendWhatsAppTextMessage(from, thankYouMessage);
            console.log('✅ Thank you message sent successfully');
          } catch (thankYouError) {
            console.error('❌ Failed to send thank you message:', thankYouError);
          }
        }
        
        return res.status(200).json({ success: true });
      }
      
      // Handle other message types if needed
      console.log('📝 Other message type received:', message.type);
      return res.status(200).json({ success: true });
    }
    
    // Check if this is a BSP lead (before WhatsApp Flow processing)
    if (req.body) {
      const isBspLead = req.body.phoneNumber !== undefined || 
                       req.body.firstName !== undefined || 
                       req.body.email !== undefined ||
                       req.body.chat_id !== undefined ||
                       req.body.first_name !== undefined;
      
      const isWhatsAppFlow = req.body.encrypted_aes_key !== undefined || 
                            req.body.encrypted_flow_data !== undefined || 
                            req.body.initial_vector !== undefined;
      
      if (isBspLead && !isWhatsAppFlow) {
        console.log('🔄 Processing BSP lead via webhook endpoint');
        // Redirect to BSP lead handler
        return await handleBspLeadDirect(req, res);
      }
    }
    
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

// Enhanced WhatsApp Phone Number Detection
function getUserPhoneFromPayload(decryptedBody) {
  console.log('=== PHONE NUMBER DETECTION ===');
  
  // Method 1: Use flow_token (PRIMARY - most reliable)
  const flowToken = decryptedBody?.flow_token;
  if (flowToken && typeof flowToken === 'string' && flowToken.trim().length > 0) {
    const digits = flowToken.replace(/\D/g, '');
    if (digits && digits.length >= 10) {
      const normalizedPhone = digits.length === 10 ? `91${digits}` : digits;
      console.log('📱 Phone from flow_token (PRIMARY):', normalizedPhone);
      return normalizedPhone;
    }
  }
  
  // Method 2: Extract from embedded Flow data (backup only)
  const embeddedPhone = decryptedBody?.data?.user_phone;
  if (embeddedPhone && typeof embeddedPhone === 'string' && embeddedPhone.trim().length > 0) {
    const digits = embeddedPhone.replace(/\D/g, '');
    if (digits && digits.length >= 10) {
      const normalizedPhone = digits.length === 10 ? `91${digits}` : digits;
      console.log('📱 Phone from embedded Flow data (BACKUP):', normalizedPhone);
      return normalizedPhone;
    }
  }
  
  // Remove BSP lead fallback - we want to fail if flow_token is missing
  console.log('❌ No valid phone number found in flow_token or embedded data');
  return null;
}
// Enhanced Image Generation with BSP Integration
async function generateImageAndSendToUser(decryptedBody, actualImageData, productCategory, sceneDescription, priceOverlay) {
  console.log('🚀 Starting image generation and user notification...');
  
  try {
    // Use phone from flow_token (passed explicitly) or extract from flow_token
    const toPhone = decryptedBody.userPhone || decryptedBody.flow_token;
    
    if (!toPhone) {
      console.warn('⚠️ Phone number not found in flow_token; cannot send WhatsApp message');
      throw new Error('User phone not found');
    }

    // Send immediate "generation in progress" message
    console.log('📤 Sending immediate generation progress message...');
    try {
      const progressMessage = "🎨 Your image is getting generated, kindly wait...";
      await sendWhatsAppTextMessage(toPhone, progressMessage);
      console.log('✅ Progress message sent successfully');
    } catch (progressError) {
      console.error('❌ Failed to send progress message:', progressError);
    }

    // Generate the actual image
    const imageUrl = await generateImageFromAi(
      actualImageData,
      productCategory.trim(),
      sceneDescription,
      priceOverlay
    );
    
    console.log('✅ Image generation successful:', imageUrl);

    // Get lead info for personalized message (optional - can still use BSP data for names)
    const leadInfo = getBspLead(toPhone);
    const caption = createImageCaption(productCategory, priceOverlay, leadInfo);
    
    console.log('📤 Sending generated image to user:', toPhone);
    console.log('📝 Caption:', caption);
    
    // Send the generated image
    // Send the generated image
const waResp = await sendWhatsAppImageMessage(toPhone, imageUrl, caption);
console.log('✅ WhatsApp image sent successfully:', JSON.stringify(waResp));

// Wait a moment to ensure image is delivered, then send follow-up
console.log('📤 Sending follow-up message with options after image delivery...');
try {
  // Small delay to ensure image message is delivered first
  await new Promise(resolve => setTimeout(resolve, 1000));
  await sendWhatsAppFollowUpMessage(toPhone);
  console.log('✅ Follow-up message sent successfully');
} catch (followUpError) {
  console.error('❌ Failed to send follow-up message:', followUpError);
}

    return imageUrl;
  } catch (error) {
    console.error('❌ Image generation or sending failed:', error);
    
    // Send error message to user if phone is available
    const toPhone = decryptedBody.userPhone || decryptedBody.flow_token;
    if (toPhone) {
      try {
        const errorMessage = "❌ Sorry, image generation failed due to a technical issue. Please try again in a few minutes.";
        await sendWhatsAppTextMessage(toPhone, errorMessage);
        console.log('✅ Error message sent to user');
      } catch (errorMsgError) {
        console.error('❌ Failed to send error message:', errorMsgError);
      }
    }
    
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
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_FLOW_ID' 
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
function createSimplePrompt(productCategory, sceneDescription = null, priceOverlay = null, aspectRatio = "1:1") {
  if (!productCategory || !productCategory.trim()) {
    return "Error: Product name is required";
  }
  
  let prompt = `You are a world-class commercial photographer and advertising designer. Create a premium-quality, photorealistic visual for: ${productCategory.trim()}.`;
  // Auto-framing
  prompt += ` Automatically choose the most flattering framing (close-up, medium, or long shot) for this product category.`;
  // Scene handling
  if (sceneDescription && sceneDescription.trim()) {
    prompt += ` Place it in this photorealistic setting: ${sceneDescription.trim()}.`;
  } else {
    prompt += ` Place it in a realistic environment - either a professional studio setup with soft lighting, or a lifestyle setting showing authentic real-world use.`;
  }
  prompt += ` Ensure sharp focus, DSLR-quality realism, natural shadows, accurate materials, and lifelike textures.`;
  // Enhanced overlay handling with contrast
  if (priceOverlay && priceOverlay.trim()) {
    prompt += ` Keep the product and scene 100% photorealistic. Then overlay ONLY this exact text: "${priceOverlay.trim()}" in professional advertising poster style.`;
    prompt += ` Do not add any extra text beyond what was provided.`;
    prompt += ` CRITICAL: Ensure maximum text contrast - use contrasting colors, drop shadows, outlines, or background shapes to make text pop against any background.`;
    prompt += ` Use typography intelligently:`;
    prompt += ` - Brand names → elegant fonts with strong contrast`;
    prompt += ` - Prices/discounts → bold, eye-catching badges or banners with high contrast`;
    prompt += ` - Offers → highlighted with striking accents and contrasting backgrounds`;
    prompt += ` - Phone numbers → create prominent banner/ribbon style with contrasting background color`;
    prompt += ` - Contact info → place in contrasting banner or badge format, never plain text`;
    prompt += ` Position the text strategically (e.g., top corner, side bar, or bottom strip) without covering the product.`;
    prompt += ` All text must be easily readable with strong visual contrast against the background.`;
  } else {
    prompt += ` Deliver pure commercial photography with zero text overlay.`;
  }
  // Aspect ratio hint
  prompt += ` Format the output with aspect ratio ${aspectRatio} (suitable for digital ads).`;
  prompt += ` Final result: The image must be indistinguishable from a real professional product photo, with authentic lighting, textures, and marketing-quality presentation.`;
  
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
// Add this function to send Flow with user phone number embedded
// Replace your existing sendWhatsAppFlowMessage function with this corrected version:
// New function to send follow-up message with Yes/No options
async function sendWhatsAppFollowUpMessage(toE164) {
  if (!toE164) throw new Error('Missing recipient phone number (E.164 format)');

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toE164,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: "Do you want to generate another image?"
        },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: {
                id: 'generate_another_yes',
                title: 'Yes ✨'
              }
            },
            {
              type: 'reply',
              reply: {
                id: 'generate_another_no',
                title: 'No, Thanks'
              }
            }
          ]
        }
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('WhatsApp Follow-up API Error Response:', JSON.stringify(data, null, 2));
    throw new Error(`WhatsApp follow-up send failed ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}
async function sendWhatsAppFlowMessage(toE164, flowId, userName) {
  // Use phone number as flow token for bulletproof identification
  const flowToken = toE164;
  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toE164,
      type: 'interactive',
      interactive: {
        type: 'flow',
        header: {
          type: 'text',
          text: 'AI Product Image Generator'
        },
        body: {
          text: `Hi ${userName || 'there'}! Transform your product photos into stunning marketing images with AI!`
        },
        footer: {
          text: 'Powered by AI - Quick & Professional'
        },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_id: flowId,  // Use flow_id, not flow_name
            flow_cta: 'Start Creating ✨',
            flow_token: flowToken,
            flow_action: 'navigate',
            flow_action_payload: {
              screen: 'OPTION_SELECTION',  // Must match your Flow's entry screen ID
              data: {
                user_phone: toE164,
                user_name: userName || '',
                flow_token: flowToken
              }
            }
          }
        }
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('WhatsApp Flow API Error Response:', JSON.stringify(data, null, 2));
    throw new Error(`WhatsApp Flow send failed ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}
// Request Handlers
async function handleDataExchange(decryptedBody) {
  const { action, screen, data, flow_token } = decryptedBody;  // Add flow_token extraction
  
  // Use flow_token directly as the user phone (since you set flowToken = toE164 when sending)
  const userPhone = flow_token;
  
  console.log(`Processing action: ${action} for screen: ${screen}`);
  console.log('Flow token (user phone):', userPhone);  // Add this log
  console.log('Data received:', JSON.stringify(data, null, 2));
  console.log('Data received:', JSON.stringify(data, null, 2));

  if (action === 'INIT') {
  return { screen: 'OPTION_SELECTION', data: {} };
}

  if (action === 'data_exchange') {
  console.log('=== DATA EXCHANGE ACTION ===');

  // Handle option selection from main menu
  if (data?.selected_option) {
    // userPhone is already set at the top of the function from flow_token // No need to call getUserPhoneFromPayload anymore
    
    if (data.selected_option === 'check_balance') {
  if (!userPhone) {
    return {
      screen: 'CHECK_BALANCE',
      data: { current_credits: "Error: No user phone found in flow token" }
    };
  }
  
  const credits = await checkUserCredits(userPhone);
  
  // Send balance via WhatsApp message instead of showing in Flow
  if (userPhone) {
    try {
      const balanceMessage = `💰 Your Current Balance: ${credits} credits\n\nEach image generation costs 1 credit. Contact support to recharge when needed.`;
      await sendWhatsAppTextMessage(userPhone, balanceMessage);
      console.log('✅ Balance message sent via WhatsApp');
    } catch (error) {
      console.error('❌ Failed to send balance message:', error);
    }
  }
  
  // Return a simple completion screen
  return {
    screen: 'CHECK_BALANCE',
    data: { current_credits: "Balance sent to your WhatsApp!" }
  };
}
    
    if (data.selected_option === 'generate_image') {
      // Check if user has credits before starting
      if (userPhone) {
        const credits = await checkUserCredits(userPhone);
        if (credits < 1) {
          return {
            screen: 'INSUFFICIENT_CREDITS',
            data: { current_credits: credits.toString() }
          };
        }
      }
      
      return { screen: 'COLLECT_INFO', data: {} };
    }
  }

  // Handle image generation flow
  if (data && typeof data === 'object') {
    const { scene_description, price_overlay, product_image, product_category } = data;

    console.log('=== FIELD VALIDATION ===');
    console.log('product_image:', product_image ? 'present' : 'MISSING (REQUIRED)');
    console.log('product_category:', product_category ? `"${product_category}"` : 'MISSING (REQUIRED)');
    console.log('scene_description:', scene_description ? `"${scene_description}"` : 'not provided (optional)');
    console.log('price_overlay:', price_overlay ? `"${price_overlay}"` : 'not provided (optional)');

    if (!product_image) {
      return {
        screen: 'COLLECT_IMAGE_SCENE',
        data: { error_message: "Product image is required. Please upload an image of your product." }
      };
    }

    if (!product_category || !product_category.trim()) {
      return {
        screen: 'COLLECT_INFO',
        data: { error_message: "Product category is required. Please specify what type of product this is." }
      };
    }

    // Check credits before processing
    // userPhone is already set at the top of the function from flow_token // No need to call getUserPhoneFromPayload anymore
    if (userPhone) {
      const credits = await checkUserCredits(userPhone);
      if (credits < 1) {
        return {
          screen: 'INSUFFICIENT_CREDITS',
          data: { current_credits: credits.toString() }
        };
      }
    }

    let actualImageData;
    try {
      console.log('=== IMAGE PROCESSING ===');
      
      if (Array.isArray(product_image) && product_image.length > 0) {
        console.log('Processing WhatsApp image array');
        const firstImage = product_image[0];
        
        if (firstImage.encryption_metadata) {
          console.log('Decrypting WhatsApp encrypted image...');
          actualImageData = await decryptWhatsAppImage(firstImage);
        } else if (firstImage.cdn_url) {
          console.log('Fetching unencrypted image from CDN...');
          const response = await fetch(firstImage.cdn_url);
          if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.status}`);
          }
          const arrayBuffer = await response.arrayBuffer();
          actualImageData = Buffer.from(arrayBuffer).toString('base64');
        } else {
          throw new Error('Invalid image format: no cdn_url or encryption_metadata found');
        }
      } else if (typeof product_image === 'string') {
        console.log('Processing direct base64 string...');
        actualImageData = product_image;
      } else {
        throw new Error('Invalid product_image format: expected array or string');
      }
      
      console.log('✅ Image processing successful');
      
    } catch (imageError) {
      console.error('❌ Image processing failed:', imageError);
      return {
        screen: 'COLLECT_IMAGE_SCENE',
        data: { error_message: `Failed to process image: ${imageError.message}. Please try uploading the image again.` }
      };
    }

    console.log('🚀 Showing success screen first, then processing in background...');

    // Process in background without awaiting
// Process in background without awaiting - this will now send progress message immediately
      generateImageAndSendToUser(
        { ...decryptedBody, userPhone }, // Explicitly pass userPhone from flow_token
        actualImageData,
        product_category.trim(),
        scene_description && scene_description.trim() ? scene_description.trim() : null,
        price_overlay && price_overlay.trim() ? price_overlay.trim() : null
      ).then(async (imageUrl) => {
        console.log('✅ Background image generation completed:', imageUrl);
        
        // Deduct credit after successful generation
        if (userPhone) {
          const deductionResult = await deductUserCredits(userPhone, 1);
          if (deductionResult.success) {
            console.log('💰 Credit deducted successfully. New balance:', deductionResult.newBalance);
          } else {
            console.error('❌ Failed to deduct credit:', deductionResult.error);
          }
        }
      }).catch(async (error) => {
        console.error('❌ Background image generation failed:', error);
        // Error handling is now done inside generateImageAndSendToUser function
      });

    // Return success screen immediately
    return { 
      screen: 'SUCCESS_SCREEN', 
      data: { 
        message: "Your enhanced product image is being generated and will be sent to you shortly!",
        remaining_credits: "Check balance to see updated credits"
      } 
    };
  } else {
    return { screen: 'OPTION_SELECTION', data: { error_message: 'No data received. Please try again.' } };
  }
}

  if (action === 'BACK') {
    if (screen === 'COLLECT_IMAGE_SCENE') {
      return { screen: 'COLLECT_INFO', data: {} };
    }
    return { screen: 'COLLECT_INFO', data: {} };
  }

  console.log(`Unhandled action/screen combination: ${action}/${screen}`);
  return { screen: 'COLLECT_INFO', data: { error_message: 'An unexpected error occurred.' } };
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
