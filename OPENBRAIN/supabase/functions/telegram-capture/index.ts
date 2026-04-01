import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient } from "@supabase/supabase-js";

// --- Environment Variables ---
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_CAPTURE_SECRET = Deno.env.get("TELEGRAM_CAPTURE_SECRET")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Reused from Open Brain MCP server ---

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

// --- Telegram Helpers ---

async function sendTelegramReply(chatId: number, text: string, replyToMessageId?: number) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_to_message_id: replyToMessageId,
      parse_mode: "Markdown",
    }),
  });
}

function formatConfirmation(metadata: Record<string, unknown>): string {
  const lines: string[] = [`🧠 *Captured* as ${metadata.type || "thought"}`];

  if (Array.isArray(metadata.topics) && metadata.topics.length) {
    lines.push(`📌 ${(metadata.topics as string[]).join(", ")}`);
  }
  if (Array.isArray(metadata.people) && metadata.people.length) {
    lines.push(`👤 ${(metadata.people as string[]).join(", ")}`);
  }
  if (Array.isArray(metadata.action_items) && metadata.action_items.length) {
    lines.push(`☑️ ${(metadata.action_items as string[]).join("; ")}`);
  }

  return lines.join("\n");
}

// --- Main Handler ---

Deno.serve(async (req) => {
  // Verify the request is from Telegram via secret token in URL
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (!secret || secret !== TELEGRAM_CAPTURE_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  try {
    const body = await req.json();

    // Telegram sends various update types — we only care about text messages
    const message = body.message;
    if (!message || !message.text) {
      return new Response("OK", { status: 200 }); // Acknowledge but ignore non-text
    }

    const chatId = message.chat.id;
    const messageId = message.message_id;
    const text = message.text;

    // Ignore bot commands other than /capture (optional: treat everything as a capture)
    // If message starts with /start or /help, respond with instructions
    if (text === "/start" || text === "/help") {
      await sendTelegramReply(
        chatId,
        "🧠 *Open Brain Capture*\n\nJust send me any thought, and I'll store it in your brain with semantic search.\n\nExamples:\n- A decision you made and why\n- A person note from a meeting\n- A content idea that popped up\n- A frustration that signals an opportunity\n\nEverything gets embedded, tagged, and searchable from any AI you use.",
        messageId
      );
      return new Response("OK", { status: 200 });
    }

    // Strip /capture prefix if used, otherwise treat the whole message as the thought
    const thought = text.startsWith("/capture ") ? text.slice(9) : text;

    // Process: embedding + metadata in parallel (same as MCP server)
    const [embedding, metadata] = await Promise.all([
      getEmbedding(thought),
      extractMetadata(thought),
    ]);

    // Store in the thoughts table
    const { error } = await supabase.from("thoughts").insert({
      content: thought,
      embedding,
      metadata: { ...metadata, source: "telegram" },
    });

    if (error) {
      await sendTelegramReply(chatId, `❌ Failed to capture: ${error.message}`, messageId);
      return new Response("OK", { status: 200 });
    }

    // Reply with confirmation
    const confirmation = formatConfirmation(metadata);
    await sendTelegramReply(chatId, confirmation, messageId);

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("Telegram capture error:", err);
    return new Response("OK", { status: 200 }); // Always 200 to Telegram so it doesn't retry
  }
});