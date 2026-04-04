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
      "Search competitor and creator research by meaning. Use for thematic/cross-creator research and PTH angle discovery. Optionally scope to a single creator for semantic search within their content.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.3),
      creator: z.string().optional().describe("Scope search to a specific creator"),
    },
  },
  async ({ query, limit, threshold, creator }) => {
    try {
      const qEmb = await getEmbedding(query);
      const filter = creator ? { creator } : {};
      const { data, error } = await supabase.rpc("match_competitor_content", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
        filter,
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
        (t: {
          content: string;
          metadata: Record<string, unknown>;
          similarity: number;
          created_at: string;
          creator?: string | null;
          platform?: string | null;
          source_type?: string | null;
          topic?: string | null;
          pth_angle?: string | null;
          article_title?: string | null;
        }, i: number) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Creator: ${t.creator || m.creator || "unknown"}`,
            `Platform: ${t.platform || m.platform || "unknown"}`,
            `Type: ${t.source_type || m.type || "unknown"}`,
          ];
          if (t.article_title) parts.push(`Title: ${t.article_title}`);
          if (t.topic) parts.push(`Topic: ${t.topic}`);
          if (t.pth_angle) parts.push(`PTH Angle: ${t.pth_angle}`);
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
      "List captured competitor content with filters. Use for single-creator audits and chronological browsing. This is your primary view for weekly research sessions — default to filtering by creator and/or last 7 days.",
    inputSchema: {
      limit: z.number().optional().default(10),
      offset: z.number().optional().default(0).describe("Pagination offset"),
      creator: z.string().optional().describe("Filter by creator name"),
      source_type: z.string().optional().describe("Filter by source type: article_summary, strategy_observation, content_analysis, audience_insight, positioning_note"),
      chunk_type: z.string().optional().describe("Filter by chunk type"),
      topic: z.string().optional().describe("Filter by topic"),
      days: z.number().optional().describe("Only content from the last N days"),
      platform: z.string().optional().describe("Filter by platform: substack, linkedin, twitter, youtube, blog, tiktok"),
      content_id: z.string().optional().describe("Filter to all chunks from a specific piece of content"),
    },
  },
  async ({ limit, offset, creator, source_type, chunk_type, topic, days, platform, content_id }) => {
    try {
      let q = supabase
        .from("competitor_content")
        .select("id, content, metadata, created_at, creator, content_url, posted_date, platform, pth_angle, topic, article_title, chunk_type, source_type, content_id")
        .eq("archived", false)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (creator) q = q.or(`creator.ilike.%${creator}%,metadata->>creator.ilike.%${creator}%`);
      if (source_type) q = q.eq("source_type", source_type);
      if (chunk_type) q = q.eq("chunk_type", chunk_type);
      if (topic) q = q.ilike("topic", `%${topic}%`);
      if (platform) q = q.ilike("platform", `%${platform}%`);
      if (content_id) q = q.eq("content_id", content_id);
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
        (t: {
          id: string;
          content: string;
          metadata: Record<string, unknown>;
          created_at: string;
          creator: string | null;
          content_url: string | null;
          posted_date: string | null;
          platform: string | null;
          pth_angle: string | null;
          topic: string | null;
          article_title: string | null;
          chunk_type: string | null;
          source_type: string | null;
          content_id: string | null;
        }, i: number) => {
          const m = t.metadata || {};
          const creatorName = t.creator || (m.creator as string) || "unknown";
          const plat = t.platform ? ` [${t.platform}]` : "";
          const url = t.content_url ? ` | ${t.content_url}` : "";
          const posted = t.posted_date ? ` | Posted: ${t.posted_date}` : "";
          const typeLabel = t.source_type || (m.type as string) || "??";
          const topicLabel = t.topic ? ` | ${t.topic}` : "";
          const titleLine = t.article_title ? `\n   Title: ${t.article_title}` : "";
          const angleLine = t.pth_angle ? `\n   PTH Angle: ${t.pth_angle}` : "";
          const contentIdLine = t.content_id ? `\n   Content ID: ${t.content_id}` : "";
          const preview = t.content.substring(0, 300) + (t.content.length > 300 ? "..." : "");
          return `${i + 1}. [ID: ${t.id}] [${new Date(t.created_at).toLocaleDateString()}] ${creatorName}${plat} (${typeLabel}${topicLabel})${posted}${url}${titleLine}${angleLine}${contentIdLine}\n   ${preview}`;
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `${data.length} competitor content item(s) (offset ${offset}):\n\n${results.join("\n\n")}`,
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
        .select("metadata, created_at, posted_date, creator, chunk_type")
        .eq("archived", false)
        .order("created_at", { ascending: false });

      const types: Record<string, number> = {};
      const topics: Record<string, number> = {};
      const creators: Record<string, number> = {};
      const chunkTypes: Record<string, number> = {};

      for (const r of data || []) {
        const m = (r.metadata || {}) as Record<string, unknown>;
        if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
        const creatorName = r.creator || (m.creator as string);
        if (creatorName) creators[creatorName] = (creators[creatorName] || 0) + 1;
        if (Array.isArray(m.topics))
          for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
        if (r.chunk_type) chunkTypes[r.chunk_type] = (chunkTypes[r.chunk_type] || 0) + 1;
      }

      const sort = (o: Record<string, number>): [string, number][] =>
        Object.entries(o)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

      const postedDates = (data || []).map(r => r.posted_date).filter(Boolean) as string[];
      const postedRange = postedDates.length
        ? `${postedDates.reduce((a, b) => a < b ? a : b)} → ${postedDates.reduce((a, b) => a > b ? a : b)}`
        : "N/A";

      const lines: string[] = [
        `Total competitor content items: ${count}`,
        `Posted date range: ${postedRange}`,
        `Captured date range: ${
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

      if (Object.keys(chunkTypes).length) {
        lines.push("", "Chunk types:");
        for (const [k, v] of sort(chunkTypes)) lines.push(`  ${k}: ${v}`);
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
      "Save competitor or creator research to the competitor database. Use for article summaries, strategy observations, audience insights, or any competitive intelligence. Great for manually adding content from creators you've discovered but don't want to fully track.",
    inputSchema: {
      content: z.string().describe("The competitor content or research note to capture. Include what you observed."),
      creator: z.string().optional().describe("Name of the creator or competitor"),
      content_url: z.string().optional().describe("URL of the specific article, post, or video being analyzed"),
      posted_date: z.string().optional().describe("When the content was published (YYYY-MM-DD)"),
      platform: z.string().optional().describe("Platform where content was published: substack, linkedin, twitter, youtube, blog, tiktok, other"),
      content_id: z.string().uuid().optional().describe("Group multiple chunks from the same piece of content — generate one UUID per content item and pass it to all its chunks"),
    },
  },
  async ({ content, creator, content_url, posted_date, platform, content_id }) => {
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
        content_id: content_id || null,
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
      "Archive competitor content by ID so it no longer appears in searches. Use to mark content as reviewed/processed or when research is no longer relevant.",
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
        .select("id, content, metadata, created_at, creator, content_url, posted_date, platform, pth_angle, topic, article_title, chunk_type, source_type, content_id")
        .eq("id", id)
        .maybeSingle();

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
        `Source Type: ${data.source_type || m.type || "unknown"}`,
        `Chunk Type: ${data.chunk_type || "unknown"}`,
        `Topic: ${data.topic || "none"}`,
        `Article Title: ${data.article_title || "none"}`,
        `Posted: ${data.posted_date || "unknown"}`,
        `URL: ${data.content_url || "none"}`,
        `Captured: ${new Date(data.created_at).toLocaleDateString()}`,
      ];
      if (data.pth_angle) parts.push(`PTH Angle: ${data.pth_angle}`);
      if (data.content_id) parts.push(`Content ID: ${data.content_id}`);
      parts.push(`\n--- FULL CONTENT ---\n`, data.content);

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

// Tool 7: List Creators
server.registerTool(
  "list_creators",
  {
    title: "List Creators",
    description:
      "Return all tracked creators with their item counts. Use first to see who is being tracked before drilling into a creator's content.",
    inputSchema: {},
  },
  async () => {
    try {
      const { data, error } = await supabase
        .from("competitor_content")
        .select("creator, metadata")
        .eq("archived", false);

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }

      const counts: Record<string, number> = {};
      for (const row of data || []) {
        const name = row.creator || ((row.metadata as Record<string, unknown>)?.creator as string) || "unknown";
        counts[name] = (counts[name] || 0) + 1;
      }

      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

      if (!sorted.length) {
        return { content: [{ type: "text" as const, text: "No creators found." }] };
      }

      const lines = sorted.map(([name, count]) => `  ${name}: ${count} item${count === 1 ? "" : "s"}`);
      return {
        content: [{ type: "text" as const, text: `${sorted.length} creator(s) tracked:\n\n${lines.join("\n")}` }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 8: List Content (grouped by content_id)
server.registerTool(
  "list_content",
  {
    title: "List Content",
    description:
      "List distinct pieces of content (articles, TikToks, etc.) grouped by content_id, with chunk counts. Use to see what content has been captured at the piece level — not individual chunks.",
    inputSchema: {
      creator: z.string().optional().describe("Filter by creator name"),
      days: z.number().optional().describe("Only content from the last N days"),
      platform: z.string().optional().describe("Filter by platform"),
    },
  },
  async ({ creator, days, platform }) => {
    try {
      let q = supabase
        .from("competitor_content")
        .select("content_id, article_title, creator, platform, content_url, posted_date, created_at, metadata")
        .eq("archived", false)
        .order("created_at", { ascending: false });

      if (creator) q = q.or(`creator.ilike.%${creator}%,metadata->>creator.ilike.%${creator}%`);
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
        return { content: [{ type: "text" as const, text: "No content found." }] };
      }

      // Group by content_id (fallback to content_url for legacy rows without content_id)
      const groups = new Map<string, {
        content_id: string | null;
        article_title: string | null;
        creator: string | null;
        platform: string | null;
        content_url: string | null;
        posted_date: string | null;
        created_at: string;
        metadata: Record<string, unknown>;
        count: number;
      }>();

      for (const row of data) {
        const key = row.content_id || row.content_url || `ungrouped-${row.created_at}`;
        if (groups.has(key)) {
          groups.get(key)!.count++;
        } else {
          groups.set(key, {
            content_id: row.content_id,
            article_title: row.article_title,
            creator: row.creator,
            platform: row.platform,
            content_url: row.content_url,
            posted_date: row.posted_date,
            created_at: row.created_at,
            metadata: (row.metadata || {}) as Record<string, unknown>,
            count: 1,
          });
        }
      }

      const items = Array.from(groups.values());
      const lines = items.map((g, i) => {
        const m = g.metadata;
        const creatorName = g.creator || (m.creator as string) || "unknown";
        const plat = g.platform ? ` [${g.platform}]` : "";
        const title = g.article_title || "Untitled";
        const posted = g.posted_date ? ` | Posted: ${g.posted_date}` : "";
        const url = g.content_url ? ` | ${g.content_url}` : "";
        const idLabel = g.content_id ? `\n   Content ID: ${g.content_id}` : "";
        return `${i + 1}. ${creatorName}${plat} | ${title} | ${g.count} chunk${g.count === 1 ? "" : "s"}${posted}${url}${idLabel}`;
      });

      return {
        content: [{ type: "text" as const, text: `${items.length} piece(s) of content:\n\n${lines.join("\n\n")}` }],
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
