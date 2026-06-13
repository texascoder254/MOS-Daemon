require('dotenv').config();
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const LEDGER_DB = process.env.INTENT_LEDGER_DB_ID;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 1. Exponential Backoff & Retry Engine (Solves Rate Limits for High-Speed Streams)
async function safeNotionCall(apiCall, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await apiCall();
    } catch (error) {
      // Retry only on Rate Limits (429) or Notion Server Errors (50x)
      if (error.status === 429 || error.status >= 500) {
        attempt++;
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        console.log(`[RATE LIMIT] Retrying in ${delay}ms...`);
        await sleep(delay);
      } else {
        throw error; // Client/Syntax errors (400) should fail immediately -> DLQ
      }
    }
  }
  throw new Error('Max retries exceeded for Notion API call.');
}

// 2. Extensible Router Pattern: Easily add new Action/Intent types in the future
const IntentHandlers = {
  
  'Session Closeout': async (intent, payload) => {
    const sourceSessionId = intent.properties['Source Session']?.relation[0]?.id;
    if (!sourceSessionId) throw new Error('Poison Pill: Session Closeout missing Source Session.');
    
    // Memory Gate (Gate i) - Dynamically handles Build vs Ops vs Boot
    const session = await safeNotionCall(() => notion.pages.retrieve({ page_id: sourceSessionId }));
    const props = session.properties;
    
    const isBuild = props['Session Type']?.select?.name === 'Build' || props['Type']?.select?.name === '🏗️ Build';
    const requiredFields = ['Fired By', 'Report'];
    if (isBuild) requiredFields.push('Build Name');

    for (let field of requiredFields) {
      if (!props[field] || (props[field].type === 'rich_text' && props[field].rich_text.length === 0)) {
        throw new Error(`Memory Gate Failed: Missing required field '${field}'`);
      }
    }
    
    const errorCount = props['Error Count']?.number || 0;
    const kiSpawned = props['KI Spawned']?.relation?.length || 0;
    if (errorCount > 0 && kiSpawned === 0) {
      throw new Error(`Memory Gate Failed: Error Count > 0 but no KI entries spawned.`);
    }

    if (isBuild && (!props['Build']?.relation || props['Build'].relation.length === 0)) {
      throw new Error(`Memory Gate Failed: Build History relation missing.`);
    }

    // Atomic Closeout Checkboxes
    await safeNotionCall(() => notion.pages.update({
      page_id: sourceSessionId,
      properties: {
        'BH Entry Written': { checkbox: true },
        'KI Logged': { checkbox: true },
        'Session Close Verified': { checkbox: true }
      }
    }));

    return "Closeout atomically routed. Memory Gate passed.";
  },

  'Standard Mutation': async (intent, payload) => {
    // Universal Executor: Can handle ANY database write, create, or update dynamically
    // Payload format: { action: "create" | "update" | "archive", params: { ...Notion API body } }
    if (!payload.action || !payload.params) {
      throw new Error("Standard Mutation missing 'action' or 'params' in JSON payload.");
    }

    let result;
    if (payload.action === 'create') {
      result = await safeNotionCall(() => notion.pages.create(payload.params));
    } else if (payload.action === 'update') {
      result = await safeNotionCall(() => notion.pages.update(payload.params));
    } else if (payload.action === 'archive') {
      result = await safeNotionCall(() => notion.pages.update({ page_id: payload.params.page_id, archived: true }));
    } else {
      throw new Error(`Unsupported Standard Mutation action: ${payload.action}`);
    }

    return `Standard Mutation '${payload.action}' executed successfully.`;
  }
  
  // Future Intent Types (e.g., 'Database Sync', 'Compute Job') can be dropped in right here.
};

async function processIntent(intent) {
  const intentId = intent.id;
  const intentType = intent.properties['Intent Type']?.select?.name;
  const rawPayload = intent.properties['Payload']?.rich_text[0]?.plain_text || "{}";

  try {
    const payload = JSON.parse(rawPayload);
    const handler = IntentHandlers[intentType];
    
    if (!handler) throw new Error(`Unsupported Intent Type: ${intentType}`);
    
    // Execute the handler
    const receiptMessage = await handler(intent, payload);
    
    // 3. Mark Valid & Log Receipt (Double-Entry Execution)
    await safeNotionCall(() => notion.pages.update({
      page_id: intentId,
      properties: {
        'Status': { select: { name: 'Valid' } },
        'Receipt Logged': { checkbox: true },
        'Receipt Payload': { rich_text: [{ text: { content: receiptMessage } }] }
      }
    }));
    console.log(`[SUCCESS] Processed ${intentType} for intent ${intentId}`);

  } catch (err) {
    // 4. Global Poison Pill Quarantine: Never crash the daemon.
    console.error(`[POISON PILL] Intent ${intentId}:`, err.message);
    await safeNotionCall(() => notion.pages.update({
      page_id: intentId,
      properties: {
        'Status': { select: { name: 'Poison Pill' } },
        'Receipt Logged': { checkbox: false },
        'Receipt Payload': { rich_text: [{ text: { content: `Error: ${err.message}` } }] }
      }
    }));
  }
}

async function pollLedger() {
  try {
    const response = await safeNotionCall(() => notion.databases.query({
      database_id: LEDGER_DB,
      filter: {
        property: 'Status',
        select: { equals: 'Pending' }
      },
      sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
      page_size: 98 // 5. Chunking read size (The Pulse)
    }));

    if (response.results.length > 0) {
      console.log(`Pulled ${response.results.length} Pending intents. Processing...`);
    }

    // 6. Sequential Processing: Honors watermark chaining to prevent race conditions
    for (const intent of response.results) {
      await processIntent(intent);
    }
  } catch (error) {
    console.error("[CRITICAL] Ledger Polling Error:", error);
  }
}

// Start the daemon loop (breathes every 10 seconds)
console.log("MOS Background Execution Daemon started...");
setInterval(pollLedger, 10000);

// Dummy web server so Render's free tier health check passes
const http = require('http');
const port = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Daemon alive')).listen(port, () => {
  console.log(`Bound to port ${port} for Render health check`);
});
