import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Shared utilities ---

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
          content: `Extract metadata from competitor/creator content. Return JSON with:
- "creator": name of the creator or competitor this content is about
- "platform": where this content was published (substack, linkedin, twitter, youtube, blog, unknown)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "article_summary", "strategy_observation", "content_analysis", "audience_insight", "positioning_note"
- "key_takeaways": array of 1-3 short takeaways (empty if none obvious)
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
    return { topics: ["uncategorized"], type: "content_analysis" };
  }
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "open-brain-competitors",
  version: "1.0.0",
});

// Tool 1: Search Competitor Content
server.registerTool(
  "search_competitors",
  {
    title: "Search Competitor Content",
    description:
      "Search competitor and creator research by meaning. Use when analyzing competitor strategies, finding patterns across creators, or looking up specific creator content.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
    },
  },
  async ({ query, limit, threshold }) => {
    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("match_competitor_content", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
        filter: {},
      });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || data.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No competitor content found matching "${query}".` }],
        };
      }

      const results = data.map(
        (t: { content: string; metadata: Record<string, unknown>; similarity: number; created_at: string }, i: number) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Creator: ${m.creator || "unknown"}`,
            `Platform: ${m.platform || "unknown"}`,
            `Type: ${m.type || "unknown"}`,
          ];
          if (Array.isArray(m.topics) && m.topics.length)
            parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          if (Array.isArray(m.key_takeaways) && m.key_takeaways.length)
            parts.push(`Takeaways: ${(m.key_takeaways as string[]).join("; ")}`);
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${data.length} result(s):\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: List Recent Competitor Content
server.registerTool(
  "list_competitor_content",
  {
    title: "List Competitor Content",
    description:
      "List recently captured competitor content with optional filters by creator, type, topic, or time range.",
    inputSchema: {
      limit: z.number().optional().default(10),
      creator: z.string().optional().describe("Filter by creator name"),
      type: z.string().optional().describe("Filter by type: article_summary, strategy_observation, content_analysis, audience_insight, positioning_note"),
      topic: z.string().optional().describe("Filter by topic tag"),
      days: z.number().optional().describe("Only content from the last N days"),
      platform: z.string().optional().describe("Filter by platform: substack, linkedin, twitter, youtube, blog, tiktok"),
    },
  },
  async ({ limit, creator, type, topic, days, platform }) => {
    try {
      let q = supabase
        .from("competitor_content")
        .select("id, content, metadata, created_at, creator, content_url, posted_date, platform")
        .eq("archived", false)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (creator) q = q.ilike("creator", `%${creator}%`);
      if (type) q = q.contains("metadata", { type });
      if (topic) q = q.contains("metadata", { topics: [topic] });
      if (platform) q = q.ilike("platform", `%${platform}%`);
      if (days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("created_at", since.toISOString());
      }

      const { data, error } = await q;

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || !data.length) {
        return { content: [{ type: "text" as const, text: "No competitor content found." }] };
      }

      const results = data.map(
        (t: { id: string; content: string; metadata: Record<string, unknown>; created_at: string; creator: string | null; content_url: string | null; posted_date: string | null; platform: string | null }, i: number) => {
          const m = t.metadata || {};
          const creatorName = t.creator || (m.creator as string) || "unknown";
          const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
          const plat = t.platform ? ` [${t.platform}]` : "";
          const url = t.content_url ? ` | ${t.content_url}` : "";
          const posted = t.posted_date ? ` | Posted: ${t.posted_date}` : "";
          return `${i + 1}. [ID: ${t.id}] [${new Date(t.created_at).toLocaleDateString()}] ${creatorName}${plat} (${m.type || "??"}${tags ? " - " + tags : ""})${posted}${url}\n   ${t.content.substring(0, 150)}${t.content.length > 150 ? "..." : ""}`;
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `${data.length} competitor content item(s):\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: Competitor Stats
server.registerTool(
  "competitor_stats",
  {
    title: "Competitor Research Stats",
    description: "Get a summary of all competitor research: totals, creators tracked, top topics, and content types.",
    inputSchema: {},
  },
  async () => {
    try {
      const { count } = await supabase
        .from("competitor_content")
        .select("*", { count: "exact", head: true })
        .eq("archived", false);

      const { data } = await supabase
        .from("competitor_content")
        .select("metadata, created_at, creator")
        .eq("archived", false)
        .order("created_at", { ascending: false });

      const types: Record<string, number> = {};
      const topics: Record<string, number> = {};
      const creators: Record<string, number> = {};

      for (const r of data || []) {
        const m = (r.metadata || {}) as Record<string, unknown>;
        if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
        const creatorName = r.creator || (m.creator as string);
        if (creatorName) creators[creatorName] = (creators[creatorName] || 0) + 1;
        if (Array.isArray(m.topics))
          for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
      }

      const sort = (o: Record<string, number>): [string, number][] =>
        Object.entries(o)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

      const lines: string[] = [
        `Total competitor content items: ${count}`,
        `Date range: ${
          data?.length
            ? new Date(data[data.length - 1].created_at).toLocaleDateString() +
              " → " +
              new Date(data[0].created_at).toLocaleDateString()
            : "N/A"
        }`,
      ];

      if (Object.keys(creators).length) {
        lines.push("", "Creators tracked:");
        for (const [k, v] of sort(creators)) lines.push(`  ${k}: ${v} items`);
      }

      if (Object.keys(types).length) {
        lines.push("", "Content types:");
        for (const [k, v] of sort(types)) lines.push(`  ${k}: ${v}`);
      }

      if (Object.keys(topics).length) {
        lines.push("", "Top topics:");
        for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 4: Capture Competitor Content
server.registerTool(
  "capture_competitor_content",
  {
    title: "Capture Competitor Content",
    description:
      "Save competitor or creator research to the competitor database. Use for article summaries, strategy observations, audience insights, or any competitive intelligence.",
    inputSchema: {
      content: z.string().describe("The competitor content or research note to capture. Include what you observed."),
      creator: z.string().optional().describe("Name of the creator or competitor"),
      content_url: z.string().optional().describe("URL of the specific article, post, or video being analyzed"),
      posted_date: z.string().optional().describe("When the content was published (YYYY-MM-DD)"),
      platform: z.string().optional().describe("Platform where content was published: substack, linkedin, twitter, youtube, blog, tiktok, other"),
    },
  },
  async ({ content, creator, content_url, posted_date, platform }) => {
    try {
      const [embedding, metadata] = await Promise.all([
        getEmbedding(content),
        extractMetadata(content),
      ]);

      const { error } = await supabase.from("competitor_content").insert({
        content,
        embedding,
        metadata: { ...metadata, source: "mcp" },
        creator: creator || (metadata.creator as string) || null,
        platform: platform || (metadata.platform as string) || null,
        content_url: content_url || null,
        posted_date: posted_date || null,
      });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to capture: ${error.message}` }],
          isError: true,
        };
      }

      const meta = metadata as Record<string, unknown>;
      let confirmation = `Captured ${meta.type || "content"} about ${creator || meta.creator || "unknown creator"}`;
      if (Array.isArray(meta.topics) && meta.topics.length)
        confirmation += ` — ${(meta.topics as string[]).join(", ")}`;
      if (content_url) confirmation += ` | ${content_url}`;
      if (posted_date) confirmation += ` | Posted: ${posted_date}`;
      if (Array.isArray(meta.key_takeaways) && meta.key_takeaways.length)
        confirmation += ` | Takeaways: ${(meta.key_takeaways as string[]).join("; ")}`;

      return {
        content: [{ type: "text" as const, text: confirmation }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 5: Archive Competitor Content
server.registerTool(
  "archive_competitor_content",
  {
    title: "Archive Competitor Content",
    description:
      "Archive competitor content by ID so it no longer appears in searches. Use when research is outdated or no longer relevant.",
    inputSchema: {
      id: z.string().describe("The ID of the competitor content to archive"),
    },
  },
  async ({ id }) => {
    try {
      const { data, error } = await supabase
        .from("competitor_content")
        .update({ archived: true })
        .eq("id", id)
        .select("content")
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Archive failed: ${error.message}` }],
          isError: true,
        };
      }

      if (!data) {
        return {
          content: [{ type: "text" as const, text: `No content found with ID ${id}.` }],
          isError: true,
        };
      }

      const preview = data.content.length > 80
        ? data.content.substring(0, 80) + "..."
        : data.content;

      return {
        content: [{ type: "text" as const, text: `Archived: "${preview}"` }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 6: Get Competitor Content by ID
server.registerTool(
  "get_competitor_content",
  {
    title: "Get Competitor Content by ID",
    description:
      "Fetch the full content of a single competitor record by ID. Use when you need the complete text — not a preview.",
    inputSchema: {
      id: z.string().describe("The ID of the competitor content record"),
    },
  },
  async ({ id }) => {
    try {
      const { data, error } = await supabase
        .from("competitor_content")
        .select("id, content, metadata, created_at, creator, content_url, posted_date, platform")
        .eq("id", id)
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data) {
        return {
          content: [{ type: "text" as const, text: `No content found with ID ${id}.` }],
          isError: true,
        };
      }

      const m = data.metadata || {};
      const parts = [
        `ID: ${data.id}`,
        `Creator: ${data.creator || m.creator || "unknown"}`,
        `Platform: ${data.platform || m.platform || "unknown"}`,
        `Posted: ${data.posted_date || "unknown"}`,
        `URL: ${data.content_url || "none"}`,
        `Type: ${m.type || "unknown"}`,
        `Topics: ${Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "none"}`,
        `Captured: ${new Date(data.created_at).toLocaleDateString()}`,
        `\n--- FULL CONTENT ---\n`,
        data.content,
      ];

      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// --- Hono App with Auth Check ---

const app = new Hono();

app.all("*", async (c) => {
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);