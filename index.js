import express from 'express';
import cors from 'cors';
import { createHash, createHmac, createDecipheriv, createCipheriv, randomBytes } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import Razorpay from 'razorpay';
import crypto from 'crypto';
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
// Replace your Razorpay webhook with this complete version:

app.post('/razorpay-webhook', express.raw({type: 'application/json'}), async (req, res) => {
  console.log('=== RAZORPAY WEBHOOK ===');
  
  // Debug logging
  console.log('Debug info:');
  console.log('- Body type:', typeof req.body);
  console.log('- Is Buffer:', Buffer.isBuffer(req.body));
  console.log('- Body length:', req.body?.length);
  console.log('- Content-Type:', req.headers['content-type']);
  console.log('- Signature received:', req.headers['x-razorpay-signature'] ? 'Yes' : 'No');
  console.log('- Webhook secret exists:', !!process.env.RAZORPAY_WEBHOOK_SECRET);
  
  try {
    const signature = req.headers['x-razorpay-signature'];
    const body = req.body;
    
    // Check if webhook secret is configured
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
      console.error('❌ RAZORPAY_WEBHOOK_SECRET environment variable is not set');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }
    
    if (!signature) {
      console.error('❌ Missing webhook signature');
      return res.status(400).json({ error: 'Missing signature' });
    }
    
    if (!Buffer.isBuffer(body)) {
      console.error('❌ Body is not a Buffer, got:', typeof body);
      console.error('This means the middleware order is still wrong!');
      return res.status(400).json({ error: 'Expected Buffer body for signature verification' });
    }
    
    // Calculate expected signature using HMAC SHA256
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(body)
      .digest('hex');
    
    console.log('Signature comparison:');
    console.log('- Received: ', signature);
    console.log('- Expected:', expectedSignature);
    console.log('- Match:', signature === expectedSignature);
    
    if (signature !== expectedSignature) {
      console.error('❌ Invalid webhook signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // Parse JSON after signature verification
    let event;
    try {
      event = JSON.parse(body.toString('utf8'));
      console.log('✅ Signature verified! Event:', event.event);
      console.log('Event ID:', req.headers['x-razorpay-event-id']);
    } catch (parseError) {
      console.error('❌ Failed to parse webhook JSON:', parseError);
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }
    
    // Handle successful payment link payment
    if (event.event === 'payment_link.paid') {
      const paymentLinkEntity = event.payload.payment_link.entity;
      const notes = paymentLinkEntity.notes;
      
      if (!notes?.user_phone || !notes?.credits_to_add) {
        console.error('❌ Missing required payment notes');
        return res.status(400).json({ error: 'Missing payment metadata' });
      }

      const userPhone = notes.user_phone;
      const creditsToAdd = parseInt(notes.credits_to_add);
      const planId = notes.plan_id;
      const amountPaid = paymentLinkEntity.amount_paid / 100;

      console.log('💳 Processing successful payment:', {
        userPhone,
        creditsToAdd,
        planId,
        amountPaid,
        paymentLinkId: paymentLinkEntity.id
      });

      // Get current wallet balance
      const currentCredits = await getLeadWallet(userPhone);
      const newBalance = currentCredits + creditsToAdd;

      // Update wallet in Supabase
      const success = await updateLeadWallet(userPhone, newBalance);
      
      if (success) {
        console.log('✅ Credits added successfully:', {
          userPhone,
          previousBalance: currentCredits,
          creditsAdded: creditsToAdd,
          newBalance
        });

        // Send success message to user
        try {
          const successMessage = `🎉 *Payment Successful!*\n\n💰 ₹${amountPaid} payment confirmed\n🎨 ${creditsToAdd} credits added to your account\n📊 Current Balance: ${newBalance} credits\n\nYou can now generate ${newBalance} amazing product images!`;
          
          await sendWhatsAppTextMessage(userPhone, successMessage);
          console.log('✅ Payment success message sent');

        } catch (messageError) {
          console.error('❌ Failed to send success message:', messageError);
        }
      } else {
        console.error('❌ Failed to update wallet in Supabase');
        
        try {
          await sendWhatsAppTextMessage(userPhone, 
            'Payment received but failed to update credits. Please contact support with your payment details.');
        } catch (msgError) {
          console.error('Failed to send error message:', msgError);
        }
      }
    }

    // Handle payment link expiry
    if (event.event === 'payment_link.expired') {
      const paymentLinkEntity = event.payload.payment_link.entity;
      const notes = paymentLinkEntity.notes;
      
      if (notes?.user_phone) {
        const userPhone = notes.user_phone;
        const planId = notes.plan_id;
        const creditsToAdd = notes.credits_to_add;

        console.log('⏰ Payment link expired:', {
          userPhone,
          planId,
          creditsToAdd,
          paymentLinkId: paymentLinkEntity.id
        });

        try {
          const expiredMessage = `⏰ *Payment Link Expired*\n\nYour payment link for ${creditsToAdd} credits has expired.\n\nWould you like to create a new payment link? Simply use the recharge option in our menu to get a fresh payment link.`;
          
          await sendWhatsAppTextMessage(userPhone, expiredMessage);
          console.log('✅ Payment expiry message sent');

          

        } catch (messageError) {
          console.error('❌ Failed to send expiry message:', messageError);
        }
      }
    }

    // Always respond with 200 to acknowledge receipt
    res.status(200).json({ status: 'ok' });
    
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
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
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});
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

// Replace the existing flow sending logic in your BSP lead handler with this:
if (leadData.phoneNumber) {
  console.log('✅ LEAD CAPTURED SUCCESSFULLY');
  
  const storedLead = storeBspLead(leadData);
  const supabaseResult = await persistBspLead(storedLead);
  
  console.log('🚀 Attempting to send Flow message to user with embedded phone number');
  console.log('User Message:', leadData.userMessage);
  console.log('Flow ID from env:', process.env.WHATSAPP_FLOW_ID);

  try {
    // Only send welcome message to NEW users
    if (supabaseResult.isNew) {
      console.log('🆕 New user detected - sending welcome message');
      const welcomeMessage = `🎉 Welcome ${leadData.firstName || 'there'} to *Bluepix*! 

I'm your AI Product Image Generator assistant from Bluesquare Group. *Bluepix* is developed at the incubation center of *Gnanamani College of Technology* https://gct.org.in/.

I can help you transform your regular product photos into stunning, professional marketing images in seconds!

✨ What Bluepix can do for you:
- Enhance product photos with *AI*
- Add professional backgrounds and lighting
- Include pricing, offers, or contact details
- Generate multiple variations

You get *3 free image credits* to explore
By using our service, you agree to our terms: https://bluesquaregroup.in/terms-and-conditions
Let's get started with your first amazing image! 🚀`;

      await sendWhatsAppTextMessage(leadData.phoneNumber, welcomeMessage);
      console.log('✅ Welcome message sent to NEW user');
      
      // Send demo video to NEW users only
      setTimeout(async () => {
        try {
          const demoVideoUrl = "https://hhioxndxnpwjbtadggtv.supabase.co/storage/v1/object/sign/video/WELCOME%20TO%20BLUEPIX%20AI%20(2).mp4?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV8yYjcwYzMwZS1kN2ZmLTRiZTktODlkNS1mNGU0Y2EzZmQzMWEiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ2aWRlby9XRUxDT01FIFRPIEJMVUVQSVggQUkgKDIpLm1wNCIsImlhdCI6MTc1ODYxMjAwNiwiZXhwIjoyMDczOTcyMDA2fQ.8r5HqdHXw6_x3EatIzjYXroRGF5WNqx7l9Uw7CY4_dA";
          const videoCaption = "📺 Watch this quick demo to see how Bluepix transforms your product images!";
          
          await sendWhatsAppVideoMessage(leadData.phoneNumber, demoVideoUrl, videoCaption);
          console.log('🎥 Demo video sent to NEW user successfully');
        } catch (videoError) {
          console.error('❌ Failed to send demo video to NEW user:', videoError);
        }
      }, 1000); // 1 second delay after welcome message
      
      // Wait before sending Flow for new users  
      setTimeout(async () => {
        try {
          const flowId = process.env.WHATSAPP_FLOW_ID;
          if (!flowId) {
            throw new Error('WHATSAPP_FLOW_ID environment variable is not set');
          }
          
          const flowResponse = await sendWhatsAppFlowMessage(
            leadData.phoneNumber, 
            flowId, 
            leadData.firstName
          );
          console.log('✅ Flow sent to NEW user');
        } catch (flowError) {
          console.error('❌ Failed to send Flow to NEW user:', flowError);
        }
      }, 3000); // 3 seconds delay to allow video to be sent first
      
    } else {
      // Returning user - send Flow immediately without welcome message or video
      console.log('👤 Returning user detected - sending Flow only');
      
      try {
        const flowId = process.env.WHATSAPP_FLOW_ID;
        if (!flowId) {
          throw new Error('WHATSAPP_FLOW_ID environment variable is not set');
        }
        
        const flowResponse = await sendWhatsAppFlowMessage(
          leadData.phoneNumber, 
          flowId, 
          leadData.firstName
        );
        console.log('✅ Flow sent to RETURNING user');
      } catch (flowError) {
        console.error('❌ Failed to send Flow to RETURNING user:', flowError);
      }
    }
    
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
      flowSent: true,
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
    // Handle WhatsApp messages if needed (keep minimal)
if (req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
  const message = req.body.entry[0].changes[0].value.messages[0];
  console.log('📝 Message received:', message.type);
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
// Razorpay webhook endpoint
// Razorpay webhook endpoint

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
async function generateImageAndSendToUser(decryptedBody, actualImageData, modelFaceData, productCategory, sceneDescription, priceOverlay) {  console.log('🚀 Starting image generation and user notification...');
                                                                                                                                           console.log('Model face provided:', modelFaceData ? 'Yes' : 'No');
                                                                                                                                           
  
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
  modelFaceData,
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
// Send the generated image
const waResp = await sendWhatsAppImageMessage(toPhone, imageUrl, caption);
console.log('✅ WhatsApp image sent successfully:', JSON.stringify(waResp));

// Return imageUrl - buttons and credit message will be sent from background processing
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
  
  caption += 'Poster made in 30 s 🚀,Try Bluepix AI for free @ bluesquaregroup.in/bluepix ✨' ;
  
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
  'WHATSAPP_FLOW_ID',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET'
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
  if (!productCategory?.trim()) return "Error: Product name required";
  
  let prompt = `Professional fashion photography for ${productCategory.trim()}.

PRODUCT ACCURACY (E-COMMERCE CRITICAL):
- Exact colors, patterns, textures from reference - zero deviation
- Preserve all design details: buttons, zippers, stitching, embellishments
- True-to-life color accuracy (prevents returns)
- Material type clearly identifiable (fabric weave, texture visible)
- Show on attractive model if clothing, premium flat-lay if accessories

TECHNICAL QUALITY:
- DSLR-level sharpness (50mm f/1.8 look), tack-sharp focus
- Professional depth of field (product sharp, background soft blur)
- Even studio lighting, no harsh shadows or blown highlights
- Natural shadows for depth, no crushed blacks

`;

  // Background with integration focus
  if (sceneDescription?.trim()) {
    prompt += `SCENE & INTEGRATION:
Environment: ${sceneDescription.trim()}
- Consistent lighting throughout (product matches background)
- Same color temperature across entire image
- Product blends naturally (no floating or pasted look)
- Realistic shadows and perspective
- Professional lifestyle setting suitable for ${productCategory.trim()}

`;
  } else {
    prompt += `BACKGROUND INTELLIGENCE:
- Accessories → Studio with premium lighting, marble/silk surfaces, luxury display
- Clothing → Fashion studio OR lifestyle setting matching garment purpose
  (Office wear → professional setting, casual → relaxed environment, evening → elegant setting)
- Clean, professional, no distracting elements
- Consistent style for similar products

`;
  }

  // Text overlay with AI-driven banner selection
  if (priceOverlay?.trim()) {
    const elements = priceOverlay.split(',').map(t => t.trim()).filter(t => t);
    
    prompt += `TEXT OVERLAY - INTELLIGENT BANNER DESIGN:
Text elements: ${elements.map((e, i) => `${i + 1}. "${e}"`).join(', ')}

🤖 AI INSTRUCTION: Analyze the text content above and select the most appropriate banner style.

BANNER STYLE SELECTION LOGIC:
1. Read each text element carefully
2. Identify the content type (festival, sale, brand, contact, or generic)
3. Choose the matching banner style from the options below
4. Apply the style-specific design to that text element

AVAILABLE BANNER STYLES:

**RIBBON BANNER** - Use when text contains:
- Festival names: Diwali, Eid, Christmas, Navratri, Pongal, Holi, etc.
- Celebration words: Festival, Celebration, Special Occasion
→ Design: Diagonal or horizontal ribbon with folded edge, decorative corners
→ Colors: Rich gold (#D4AF37), deep red (#C41E3A), festive green (#2E7D32)
→ Effects: Warm glow, sparkle accents, ornamental details
→ Position: Top-left diagonal or horizontal across top

**BURST/EXPLOSION SHAPE** - Use when text contains:
- Discounts: %, OFF, Sale, Discount, Deal, Flat
- Numbers with %: "50%", "Up to 70%", "Flat 40% OFF"
- Urgency: Limited, Flash, Hurry, Today Only
→ Design: 8-12 point star burst or explosion shape
→ Colors: Electric red (#FF3131), vibrant orange (#FF6B35), hot yellow (#FFD23F)
→ Effects: Bold shadows (6-8px), thick borders (3-4px)
→ Position: Top-left corner for maximum impact

**CORNER PEEL TAG** - Use when text contains:
- Small discounts: Percentage symbols, short sale text
- Quick offers: "New", "Hot", percentage badges
→ Design: Sticker peeling from corner with curled edge
→ Colors: Bright attention colors (red, orange, yellow)
→ Effects: 3D curled edge shadow, lift-off appearance
→ Position: Top-right or top-left corner

**FLOATING CARD** - Use when text contains:
- Brand names: [Name] Textiles, [Name] Fashion, [Name] Boutique
- Store names: Shop, Store, Collection, Designer, Couture
- Elegant messaging: Premium, Exclusive, Luxury
→ Design: Clean rectangular card with strong elevation shadow
→ Colors: Black, white, navy, metallic gold (luxury palette)
→ Effects: 6-8px shadow for floating effect, slight rounded corners (8-10px)
→ Position: Top-center or bottom-center for prominence

**GLASSMORPHISM BANNER** - Use when text contains:
- Modern brand names with contemporary feel
- Premium product messaging
- Tech-forward or minimalist brands
→ Design: Semi-transparent frosted glass blur effect
→ Colors: Any, but with 70-80% transparency and backdrop blur
→ Effects: Thin border (1-2px), subtle gradient overlay
→ Position: Anywhere, adaptable and modern

**SMALL STICKER BADGE** - Use when text contains:
- Phone numbers: 10 digits, formatted numbers
- Email/website: @, .com, .in, .org
- Contact words: Call, Contact, WhatsApp, Phone, Mobile
→ Design: Small rounded rectangle, minimal effects
→ Colors: Soft gray (#757575), muted blue (#546E7A), neutral tones
→ Effects: Subtle shadow (2-3px), simple clean borders
→ Position: Bottom-right or bottom-left corner (discreet)

**STICKER/BADGE (DEFAULT)** - Use when text doesn't match above:
- Generic promotional text, product features, ambiguous content
→ Design: Versatile rounded rectangle (12-15px corners)
→ Colors: Based on overall image mood and contrast needs
→ Effects: Standard shadow (4-6px), 2-3px borders
→ Position: Top-left or top-center based on hierarchy

EXAMPLE DECISION PROCESS:
• "${elements[0]}" = "Diwali Sale 50% OFF" → BURST SHAPE with festive colors (sale dominant)
• "${elements[0]}" = "Sharma Textiles" → FLOATING CARD with elegant black/white/gold
• "${elements[0]}" = "Call: 9876543210" → SMALL STICKER BADGE, bottom corner, gray
• "${elements[0]}" = "New Arrival" → STICKER/BADGE (default)

📐 BANNER SIZING & HIERARCHY:
- Primary "${elements[0]}": 40-50% image width, DOMINANT presence, top-left or center
- Secondary "${elements[1] || 'N/A'}": 25-35% width, top-right or opposite corner, 60-70% size of primary
- Tertiary "${elements[2] || 'N/A'}": 20-30% width, bottom corners, 50-60% size of primary
- Additional elements: 15-25% width, edge placement, subtle

Z-PATTERN LAYOUT:
┌─────────────────────────────┐
│ PRIMARY ★        SECONDARY  │ ← Hot zone (immediate attention)
│                             │
│    [PRODUCT HERO SPACE]     │ ← Sacred zone (never block)
│                             │
│ TERTIARY        ADDITIONAL  │ ← Completion zone (balanced)
└─────────────────────────────┘

VISUAL EFFECTS FOR ATTRACTIVENESS:
- Drop shadows: 4-6px offset, 40-60% opacity, slight blur for depth
- Borders: 2-4px solid or gradient for framing
- Rounded corners: 12-15px for modern friendly look
- Semi-transparent fills: 80-95% opacity for sophistication
- Typography: Bold weights (700-900) for primary, medium (500-600) for secondary
- High contrast: Minimum 4.5:1 ratio for readability

LAYOUT PRECISION:
- 8-10% margins from all edges (professional spacing)
- Text never overlaps critical product details
- Product occupies 60-75% of frame (hero element)
- 15-20% empty space for breathing room
- Balanced composition, non-cluttered premium look

🎯 ATTRACTIVENESS GOAL:
Make viewers STOP scrolling! Eye-catching enough to increase click-through rates.
Instagram/Pinterest quality, modern, professional, premium e-commerce standard.

NOTE: Text spelling accuracy will be verified in post-production.

`;
  }

  prompt += `COMPOSITION & FRAMING:
- Product occupies 60-75% of frame (e-commerce standard)
- Appropriate angle: Full body (complete outfits), Upper body (tops/jackets), Detail shots (intricate pieces)
- Natural relaxed pose for models, elegant display for flat-lays
- Rule of thirds or centered based on product
- ${aspectRatio} aspect ratio

FINAL QUALITY BENCHMARKS:
- Indistinguishable from Myntra, Zara, H&M product images
- Suitable for e-commerce listings, print catalogs, social media ads
- Professional enough for ${productCategory.trim()} at its price point
- Ready for immediate publication (after text/color QA)`;

  return prompt;
}

function createPromptWithModel(productCategory, sceneDescription = null, priceOverlay = null, aspectRatio = "1:1") {
  if (!productCategory?.trim()) return "Error: Product name required";
  
  let prompt = `Professional fashion photography assignment: ${productCategory.trim()}.

IMAGE ANALYSIS:
Image 1 (Product): Extract exact design, colors, patterns, textures, all details
Image 2 (Model Face): Use exact facial features for face only
Body: Professional fashion model proportions (face from Image 2, body optimized for product display)

PRODUCT ACCURACY (CRITICAL):
- Exact colors from reference (true-to-life, prevents returns)
- All patterns, textures, design details preserved
- Material quality clearly visible (fabric weave, stitching)
- Product fits naturally on model body
- Fabric drape follows body contours realistically

`;

  // Enhanced scene integration
  if (sceneDescription?.trim()) {
    prompt += `SCENE CREATION (CRITICAL - NEW BACKGROUND):
⚠️ DISCARD Image 1 background completely
CREATE NEW ENVIRONMENT: ${sceneDescription.trim()}

Integration requirements:
- Model + product naturally present in this new setting
- Appropriate props, furniture, atmospheric elements
- Lighting matches environment (sun, window, studio as appropriate)
- Realistic perspective and scale
- Professional lifestyle photography quality

`;
  } else {
    prompt += `BACKGROUND SELECTION:
- Professional studio lighting OR lifestyle setting for ${productCategory.trim()}
- Clean, modern, commercially appropriate
- Enhances product without competing for attention

`;
  }

  // CRITICAL: Face blending
  prompt += `🔴 FACE BLENDING - HIGHEST PRIORITY 🔴

UNIFIED LIGHTING (Prevents "Pasted Face" Look):

Step 1 - Analyze Scene Light:
- Primary source? (sun, window, studio, ambient)
- Direction? (front, side, back, top)
- Quality? (hard shadows or soft diffused)
- Intensity? (bright or dim)
- Temperature? (warm/golden or cool/blue)

Step 2 - Match Face to Scene Exactly:
- Face lit by SAME source as environment
- Shadow direction on face matches scene shadows
- Shadow intensity identical (face shadows = object shadows)
- Highlight brightness matches environment highlights
- Color temperature unified (warm scene = warm face, cool scene = cool face)

Step 3 - Integration Details:
- Eyes reflect scene light sources (window in scene = window in eyes)
- Skin tone shifts with lighting (golden hour = warm skin, overcast = neutral)
- Face receives same atmospheric effects (fog, haze, color bounce from surfaces)
- Rim lighting if backlit scene
- Fill light matches ambient environment

VERIFICATION QUESTIONS:
1. Does face brightness match overall image brightness?
2. Are shadows pointing the same direction?
3. Same color temperature throughout?
4. Would this look like ONE photograph taken together?

If ANY answer is NO → Fix lighting integration before finalizing.

COMPOSITING QUALITY:
- No visible seams or edges
- Face, body, garment, background look like single photograph
- Professional seamless integration
- No floating or disconnected elements

`;

  // Professional standards
  prompt += `PHOTOGRAPHY STANDARDS:
- DSLR quality (50mm f/1.8 or 85mm f/1.4 aesthetic)
- Tack-sharp focus on product details
- Professional depth of field (subject sharp, background soft)
- Natural skin retouching (professional but realistic)
- Even lighting, no harsh shadows or blown highlights

COMPOSITION:
- Natural relaxed pose showing face and product clearly
- Product occupies 60-75% of frame
- Appropriate angle for ${productCategory.trim()}
- ${aspectRatio} aspect ratio
- Professional model positioning in scene (not floating)

`;

  // Text overlay (same system as simple prompt)
  if (priceOverlay?.trim()) {
    const elements = priceOverlay.split(',').map(t => t.trim()).filter(t => t);
    
    prompt += `TEXT OVERLAY - INTELLIGENT BANNER DESIGN:
Text elements: ${elements.map((e, i) => `${i + 1}. "${e}"`).join(', ')}

🤖 AI INSTRUCTION: Analyze the text content above and select the most appropriate banner style.

BANNER STYLE SELECTION LOGIC:
1. Read each text element carefully
2. Identify the content type (festival, sale, brand, contact, or generic)
3. Choose the matching banner style from the options below
4. Apply the style-specific design to that text element

AVAILABLE BANNER STYLES:

**RIBBON BANNER** - Use when text contains:
- Festival names: Diwali, Eid, Christmas, Navratri, Pongal, Holi, etc.
- Celebration words: Festival, Celebration, Special Occasion
→ Design: Diagonal or horizontal ribbon with folded edge, decorative corners
→ Colors: Rich gold (#D4AF37), deep red (#C41E3A), festive green (#2E7D32)
→ Effects: Warm glow, sparkle accents, ornamental details
→ Position: Top-left diagonal or horizontal across top

**BURST/EXPLOSION SHAPE** - Use when text contains:
- Discounts: %, OFF, Sale, Discount, Deal, Flat
- Numbers with %: "50%", "Up to 70%", "Flat 40% OFF"
- Urgency: Limited, Flash, Hurry, Today Only
→ Design: 8-12 point star burst or explosion shape
→ Colors: Electric red (#FF3131), vibrant orange (#FF6B35), hot yellow (#FFD23F)
→ Effects: Bold shadows (6-8px), thick borders (3-4px)
→ Position: Top-left corner for maximum impact

**CORNER PEEL TAG** - Use when text contains:
- Small discounts: Percentage symbols, short sale text
- Quick offers: "New", "Hot", percentage badges
→ Design: Sticker peeling from corner with curled edge
→ Colors: Bright attention colors (red, orange, yellow)
→ Effects: 3D curled edge shadow, lift-off appearance
→ Position: Top-right or top-left corner

**FLOATING CARD** - Use when text contains:
- Brand names: [Name] Textiles, [Name] Fashion, [Name] Boutique
- Store names: Shop, Store, Collection, Designer, Couture
- Elegant messaging: Premium, Exclusive, Luxury
→ Design: Clean rectangular card with strong elevation shadow
→ Colors: Black, white, navy, metallic gold (luxury palette)
→ Effects: 6-8px shadow for floating effect, slight rounded corners (8-10px)
→ Position: Top-center or bottom-center for prominence

**GLASSMORPHISM BANNER** - Use when text contains:
- Modern brand names with contemporary feel
- Premium product messaging
- Tech-forward or minimalist brands
→ Design: Semi-transparent frosted glass blur effect
→ Colors: Any, but with 70-80% transparency and backdrop blur
→ Effects: Thin border (1-2px), subtle gradient overlay
→ Position: Anywhere, adaptable and modern

**SMALL STICKER BADGE** - Use when text contains:
- Phone numbers: 10 digits, formatted numbers
- Email/website: @, .com, .in, .org
- Contact words: Call, Contact, WhatsApp, Phone, Mobile
→ Design: Small rounded rectangle, minimal effects
→ Colors: Soft gray (#757575), muted blue (#546E7A), neutral tones
→ Effects: Subtle shadow (2-3px), simple clean borders
→ Position: Bottom-right or bottom-left corner (discreet)

**STICKER/BADGE (DEFAULT)** - Use when text doesn't match above:
- Generic promotional text, product features, ambiguous content
→ Design: Versatile rounded rectangle (12-15px corners)
→ Colors: Based on overall image mood and contrast needs
→ Effects: Standard shadow (4-6px), 2-3px borders
→ Position: Top-left or top-center based on hierarchy

EXAMPLE DECISION PROCESS:
• "${elements[0]}" = "Diwali Sale 50% OFF" → BURST SHAPE with festive colors (sale dominant)
• "${elements[0]}" = "Sharma Textiles" → FLOATING CARD with elegant black/white/gold
• "${elements[0]}" = "Call: 9876543210" → SMALL STICKER BADGE, bottom corner, gray
• "${elements[0]}" = "New Arrival" → STICKER/BADGE (default)

📐 BANNER SIZING & HIERARCHY:
- Primary "${elements[0]}": 40-50% image width, DOMINANT presence, top-left or center
- Secondary "${elements[1] || 'N/A'}": 25-35% width, top-right or opposite corner, 60-70% size of primary
- Tertiary "${elements[2] || 'N/A'}": 20-30% width, bottom corners, 50-60% size of primary
- Additional elements: 15-25% width, edge placement, subtle

Z-PATTERN LAYOUT:
┌─────────────────────────────┐
│ PRIMARY ★        SECONDARY  │ ← Hot zone (immediate attention)
│                             │
│    [PRODUCT HERO SPACE]     │ ← Sacred zone (never block)
│                             │
│ TERTIARY        ADDITIONAL  │ ← Completion zone (balanced)
└─────────────────────────────┘

VISUAL EFFECTS FOR ATTRACTIVENESS:
- Drop shadows: 4-6px offset, 40-60% opacity, slight blur for depth
- Borders: 2-4px solid or gradient for framing
- Rounded corners: 12-15px for modern friendly look
- Semi-transparent fills: 80-95% opacity for sophistication
- Typography: Bold weights (700-900) for primary, medium (500-600) for secondary
- High contrast: Minimum 4.5:1 ratio for readability

LAYOUT PRECISION:
- 8-10% margins from all edges (professional spacing)
- Text never overlaps critical product details
- Product occupies 60-75% of frame (hero element)
- 15-20% empty space for breathing room
- Balanced composition, non-cluttered premium look

🎯 ATTRACTIVENESS GOAL:
Make viewers STOP scrolling! Eye-catching enough to increase click-through rates.
Instagram/Pinterest quality, modern, professional, premium e-commerce standard.

NOTE: Text spelling accuracy will be verified in post-production.

`;
  }

  prompt += `COMPOSITION & FRAMING:
- Product occupies 60-75% of frame (e-commerce standard)
- Appropriate angle: Full body (complete outfits), Upper body (tops/jackets), Detail shots (intricate pieces)
- Natural relaxed pose for models, elegant display for flat-lays
- Rule of thirds or centered based on product
- ${aspectRatio} aspect ratio

FINAL QUALITY BENCHMARKS:
- Indistinguishable from Myntra, Zara, H&M product images
- Suitable for e-commerce listings, print catalogs, social media ads
- Professional enough for ${productCategory.trim()} at its price point
- Ready for immediate publication (after text/color QA)`;

  return prompt;
}
// Simplified Gemini API call
async function generateImageFromAi(productImageBase64, modelFaceBase64, productCategory, sceneDescription = null, priceOverlay = null) {
  console.log('=== GENERATE IMAGE FROM AI ===');
  console.log('Parameters:');
  console.log('- productImageBase64 length:', productImageBase64 ? productImageBase64.length : 0);
  console.log('- modelFaceBase64 length:', modelFaceBase64 ? modelFaceBase64.length : 0);
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
  
  // Clean product image base64
  let cleanProductBase64 = productImageBase64;
  if (productImageBase64.startsWith('data:')) {
    const base64Index = productImageBase64.indexOf(',');
    if (base64Index !== -1) {
      cleanProductBase64 = productImageBase64.substring(base64Index + 1);
      console.log("✅ Product image data URL prefix removed, new length:", cleanProductBase64.length);
    }
  }

  // Clean model face base64 if provided
  let cleanModelBase64 = null;
  if (modelFaceBase64) {
    cleanModelBase64 = modelFaceBase64;
    if (modelFaceBase64.startsWith('data:')) {
      const base64Index = modelFaceBase64.indexOf(',');
      if (base64Index !== -1) {
        cleanModelBase64 = modelFaceBase64.substring(base64Index + 1);
        console.log("✅ Model face data URL prefix removed, new length:", cleanModelBase64.length);
      }
    }
  }

  console.log("Step 2: Creating prompt...");
  
  // Use appropriate prompt based on whether model face is provided
  const simplePrompt = cleanModelBase64 
    ? createPromptWithModel(productCategory, sceneDescription, priceOverlay)
    : createSimplePrompt(productCategory, sceneDescription, priceOverlay);
  
  console.log("Prompt created with model face:", !!cleanModelBase64);

  console.log("Step 3: Sending to Gemini API...");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent?key=${apiKey}`;

  // Build parts array
  const parts = [
    { text: simplePrompt }
  ];

  // Always add product image first
  parts.push({
    inlineData: {
      mimeType: "image/jpeg",
      data: cleanProductBase64
    }
  });

  // Add model face if provided
  if (cleanModelBase64) {
    parts.push({
      inlineData: {
        mimeType: "image/jpeg",
        data: cleanModelBase64
      }
    });
    console.log("✅ Including model face in request");
  }

  const requestBody = {
    contents: [
      {
        parts: parts
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

// Add this function right here:
async function sendWhatsAppVideoMessage(toE164, videoUrl, caption = '') {
  if (!toE164) throw new Error('Missing recipient phone number (E.164 format)');
  if (!videoUrl) throw new Error('Missing video URL');
  
  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  
  const requestBody = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toE164,
    type: 'video',
    video: {
      link: videoUrl
    }
  };

  // Add caption if provided
  if (caption && caption.trim().length > 0) {
    requestBody.video.caption = caption;
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    const result = await resp.json();
    
    if (!resp.ok) {
      console.error('WhatsApp Video API Error:', result);
      throw new Error(`WhatsApp API error: ${result.error?.message || 'Unknown error'}`);
    }

    console.log('✅ WhatsApp video message sent successfully:', result);
    return result;
    
  } catch (error) {
    console.error('❌ Failed to send WhatsApp video message:', error);
    throw error;
  }
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
          text: 'Bluepix AI'
        },
        body: {
          text: `Hi ${userName || 'there'}! Transform your product photos into stunning marketing images with AI!`
        },
        footer: {
          text: 'Powered by Bluepix AI - Quick & Professional'
        },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_id: flowId,  // Use flow_id, not flow_name
            flow_cta: 'Start Creating ',
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
    
    if (data.selected_option === 'recharge') {
      return { screen: 'RECHARGE_SCREEN', data: {} };
    }
  }

  // Handle recharge plan selection
  if (data?.selected_plan) {
    const planDetails = {
      starter: { name: 'Starter Plan', amount: 299, credits: 10 },
      business: { name: 'Business Plan', amount: 599, credits: 25 },
      growth: { name: 'Growth Plan', amount: 1099, credits: 50 },
      agency: { name: 'Agency Plan', amount: 1999, credits: 100 }
    };

    const selectedPlan = planDetails[data.selected_plan];
    if (!selectedPlan) {
      return {
        screen: 'RECHARGE_SCREEN',
        data: { error_message: 'Invalid plan selected. Please try again.' }
      };
    }

    const userPhone = flow_token;
    if (!userPhone) {
      return {
        screen: 'RECHARGE_SCREEN', 
        data: { error_message: 'Unable to identify user. Please try again.' }
      };
    }

    try {
      const paymentLink = await createRazorpayPaymentLink(
        userPhone,
        data.selected_plan,
        selectedPlan.amount,
        selectedPlan.credits
      );

      sendPaymentLinkMessage(userPhone, paymentLink, selectedPlan).catch(error => {
        console.error('Background payment link send failed:', error);
      });

      return {
  screen: 'PAYMENT_INITIATED',
  data: {}
};

    } catch (error) {
      console.error('❌ Payment link creation failed:', error);
      return {
        screen: 'RECHARGE_SCREEN',
        data: { error_message: 'Failed to create payment link. Please try again or contact support.' }
      };
    }
  }

  // Handle image generation flow
  if (data && typeof data === 'object') {
    const { scene_description, price_overlay, product_image, model_face, product_category } = data;
    console.log('=== FIELD VALIDATION ===');
console.log('product_image:', product_image ? 'present' : 'MISSING (REQUIRED)');
console.log('model_face:', model_face ? 'present' : 'not provided (optional)');
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
    let modelFaceData = null;
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
      // Process model face if provided
if (model_face) {
  console.log('=== MODEL FACE PROCESSING ===');
  
  if (Array.isArray(model_face) && model_face.length > 0) {
    console.log('Processing WhatsApp model face array');
    const firstFace = model_face[0];
    
    if (firstFace.encryption_metadata) {
      console.log('Decrypting WhatsApp encrypted model face...');
      modelFaceData = await decryptWhatsAppImage(firstFace);
    } else if (firstFace.cdn_url) {
      console.log('Fetching unencrypted model face from CDN...');
      const response = await fetch(firstFace.cdn_url);
      if (!response.ok) {
        throw new Error(`Failed to fetch model face: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      modelFaceData = Buffer.from(arrayBuffer).toString('base64');
    } else {
      throw new Error('Invalid model face format: no cdn_url or encryption_metadata found');
    }
  } else if (typeof model_face === 'string') {
    console.log('Processing direct base64 string for model face...');
    modelFaceData = model_face;
  } else {
    console.log('⚠️ Model face provided but in invalid format, skipping...');
  }
  
  console.log('✅ Model face processing successful');
} else {
  console.log('ℹ️ No model face provided, continuing without it');
}
      
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
      // Process in background without awaiting - this will now send progress message immediately
generateImageAndSendToUser(
  { ...decryptedBody, userPhone },
  actualImageData,
  modelFaceData,
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
      
      // Send credit update message after image delivery
      // Send credit update message after image delivery
try {
  await new Promise(resolve => setTimeout(resolve, 2000));
  const balanceUpdateMessage = `✅ Image generated successfully! 1 credit used.\n\n💰 Your remaining balance: ${deductionResult.newBalance} credits`;
  await sendWhatsAppTextMessage(userPhone, balanceUpdateMessage);
  console.log('✅ Balance update message sent via WhatsApp');
  
  // Check if user has no credits left and send recharge suggestion
  if (deductionResult.newBalance <= 0) {
    setTimeout(async () => {
      try {
        const rechargeMessage = `🔋 You've used all your credits! To generate more amazing images, use our recharge option to add more credits to your account.`;
        await sendWhatsAppTextMessage(userPhone, rechargeMessage);
        console.log('✅ Recharge suggestion sent');
      } catch (error) {
        console.error('❌ Failed to send recharge message:', error);
      }
    }, 3000);
  }
} catch (error) {
  console.error('❌ Failed to send balance update message:', error);
}   
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
// Razorpay functions
async function createRazorpayPaymentLink(phoneNumber, planId, amount, credits) {
  try {
    const planNames = {
      starter: 'Starter Plan',
      business: 'Business Plan', 
      growth: 'Growth Plan',
      agency: 'Agency Plan'
    };

    const paymentLink = await razorpay.paymentLink.create({
      amount: amount * 100, // Amount in paise
      currency: 'INR',
      description: `${planNames[planId]} - ${credits} Image Credits`,
      customer: {
        contact: phoneNumber
      },
      notify: {
        sms: false,
        email: false
      },
      reminder_enable: false,
      notes: {
        user_phone: phoneNumber,
        plan_id: planId,
        credits_to_add: credits.toString(),
        created_at: new Date().toISOString()
      }
    });

    console.log('✅ Payment link created:', paymentLink.short_url);
    return paymentLink;
  } catch (error) {
    console.error('❌ Failed to create payment link:', error);
    throw error;
  }
}

async function sendPaymentLinkMessage(phoneNumber, paymentLink, planDetails) {
  try {
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
        to: phoneNumber,
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          header: {
            type: 'text',
            text: '💳 Payment Ready'
          },
          body: {
            text: `📦 ${planDetails.name}\n💰 Amount: ₹${planDetails.amount}\n🎨 Credits: ${planDetails.credits} images\n\nComplete your payment securely using the button below:`
          },
          footer: {
            text: 'Secure payment via Razorpay'
          },
          action: {
            name: 'cta_url',
            parameters: {
              display_text: 'Pay Now ',
              url: paymentLink.short_url
            }
          }
        }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`WhatsApp send failed ${response.status}: ${JSON.stringify(data)}`);
    }
    
    console.log('✅ Payment link sent via WhatsApp with CTA button');
    return data;
  } catch (error) {
    console.error('❌ Failed to send payment link:', error);
    throw error;
  }
}
// Start server
app.listen(PORT, () => {
  console.log(`🚀 Railway WhatsApp Webhook Server running on port ${PORT}`);
  console.log(`📍 Webhook URL: https://your-app.railway.app/webhook`);
  console.log(`📍 BSP Lead URL: https://your-app.railway.app/bsp-lead`);
  console.log(`📍 Debug URL: https://your-app.railway.app/debug-leads`);
});
