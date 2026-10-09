/* ---------------------------------------------------------------------------
 * The blog article feed.
 *
 * An outside content service (GrandRanker) POSTs finished articles here. They
 * are stored in Postgres, and the website's build turns them into ordinary
 * static pages under /blog/ on skytransfers.com.au - the same treatment the
 * 421 suburb pages get. Articles therefore live on the real domain, are served
 * from the CDN, and cost nothing extra to host.
 *
 * Nothing in this file is on the booking path. It is mounted in a try/catch at
 * the end of stripe-server.js: if it throws on boot, one line is logged and the
 * site carries on taking bookings. Needs DATABASE_URL and GRANDRANKER_SECRET;
 * without either it switches itself off and says so.
 * ------------------------------------------------------------------------- */
module.exports = function installBlogFeed(ctx) {
  const { app } = ctx;
  const express = require("express");
  const crypto = require("crypto");
  const { Pool } = require("pg");

  const SECRET = process.env.GRANDRANKER_SECRET || "";
  /* Optional. A Render deploy hook URL for the static site: hitting it
     rebuilds the site so a new article is live in about a minute. Without it
     articles still arrive and store, they just appear at the next deploy. */
  const DEPLOY_HOOK = process.env.BLOG_DEPLOY_HOOK || "";
  const pool = process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 2,
      })
    : null;
  const ON = Boolean(pool && SECRET);

  /* The slug becomes a filename at build time, so it is the one field an
     outside service could use to write somewhere it should not. Anything that
     is not a plain lowercase slug is rejected here and again in the build. */
  const cleanSlug = (s) => {
    const v = String(s || "").toLowerCase().trim()
      .replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
    return v && v.length <= 120 && v !== "index" ? v : null;
  };

  const sameSecret = (given) => {
    const a = Buffer.from(String(given || ""));
    const b = Buffer.from(SECRET);
    /* timingSafeEqual throws on a length mismatch, so compare lengths first
       and keep the comparison constant-time for equal-length guesses. */
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  async function initSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS blog_articles (
        external_id      TEXT PRIMARY KEY,
        slug             TEXT UNIQUE NOT NULL,
        title            TEXT,
        meta_title       TEXT,
        meta_description TEXT,
        subtitle         TEXT,
        content_html     TEXT,
        category         TEXT,
        author_name      TEXT,
        image_url        TEXT,
        read_time        TEXT,
        word_count       INT,
        tags             JSONB,
        faqs             JSONB,
        json_ld          JSONB,
        language_code    TEXT,
        published_at     TIMESTAMPTZ,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS blog_articles_published
        ON blog_articles (published_at DESC);
    `);
  }

  const asDate = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  };
  const asJson = (v) => (v == null ? null : JSON.stringify(v));

  async function upsert(a) {
    const slug = cleanSlug(a.slug || a.title);
    if (!slug) return { ok: false, reason: "unusable slug" };
    const id = String(a.id == null ? slug : a.id);
    await pool.query(
      `INSERT INTO blog_articles
         (external_id, slug, title, meta_title, meta_description, subtitle,
          content_html, category, author_name, image_url, read_time, word_count,
          tags, faqs, json_ld, language_code, published_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
       ON CONFLICT (external_id) DO UPDATE SET
         slug = EXCLUDED.slug, title = EXCLUDED.title,
         meta_title = EXCLUDED.meta_title, meta_description = EXCLUDED.meta_description,
         subtitle = EXCLUDED.subtitle, content_html = EXCLUDED.content_html,
         category = EXCLUDED.category, author_name = EXCLUDED.author_name,
         image_url = EXCLUDED.image_url, read_time = EXCLUDED.read_time,
         word_count = EXCLUDED.word_count, tags = EXCLUDED.tags,
         faqs = EXCLUDED.faqs, json_ld = EXCLUDED.json_ld,
         language_code = EXCLUDED.language_code,
         published_at = EXCLUDED.published_at, updated_at = now()`,
      [id, slug, a.title || null, a.meta_title || null, a.meta_description || null,
       a.subtitle || null, a.content_html || null, a.category || null,
       a.author_name || null, a.image_url || null, a.read_time || null,
       Number.isFinite(Number(a.word_count)) ? Number(a.word_count) : null,
       asJson(a.tags), asJson(a.faqs), asJson(a.json_ld_schema || a.json_ld),
       a.language_code || null, asDate(a.publish_date || a.published_at)]
    );
    return { ok: true, slug };
  }

  /* Fire and forget. A rebuild that does not start is a late article, not a
     lost one - the next deploy picks it up either way. */
  function pokeBuild(why) {
    if (!DEPLOY_HOOK) return;
    fetch(DEPLOY_HOOK, { method: "POST" })
      .then((r) => console.log(`blog: rebuild requested (${why}) -> ${r.status}`))
      .catch((e) => console.error("blog: rebuild request failed:", e.message));
  }

  if (!ON) {
    console.log("blog: feed off (needs DATABASE_URL and GRANDRANKER_SECRET)");
    /* Still answer the webhook so the sender gets a clear 503 rather than a
       404 that looks like the wrong URL. */
    app.all("/api/articles-webhook", (req, res) => {
      if (req.method === "GET" || req.method === "HEAD") return res.status(200).send("ok");
      res.status(503).json({ error: "blog feed is not configured on this server" });
    });
    return { on: false };
  }

  initSchema()
    .then(() => console.log("blog: feed ready"
      + (DEPLOY_HOOK ? " (auto-rebuild on)" : " (no deploy hook; articles appear at the next deploy)")))
    .catch((e) => console.error("blog: schema failed:", e.message));

  app.all("/api/articles-webhook", express.json({ limit: "10mb" }), async (req, res) => {
    if (req.method === "GET" || req.method === "HEAD") return res.status(200).send("ok");
    if (req.method !== "POST") return res.status(405).end();
    if (!sameSecret(req.get("X-API-Key"))) return res.status(401).json({ error: "unauthorized" });
    const { event_type, data } = req.body || {};
    try {
      if (event_type === "publish_articles") {
        const list = (data && data.articles) || [];
        const done = [], skipped = [];
        for (const a of list) {
          const r = await upsert(a);
          (r.ok ? done : skipped).push(r.slug || a.slug || a.id);
        }
        if (done.length) pokeBuild(`${done.length} article(s)`);
        console.log(`blog: stored ${done.length}, skipped ${skipped.length}`);
        return res.json({ ok: true, stored: done, skipped });
      }
      if (event_type === "unpublish_article") {
        const id = String((data && data.id) != null ? data.id : "");
        const r = await pool.query(
          "DELETE FROM blog_articles WHERE external_id = $1 OR slug = $1", [id]);
        if (r.rowCount) pokeBuild("unpublish");
        return res.json({ ok: true, removed: r.rowCount });
      }
      return res.status(400).json({ error: "unknown event_type" });
    } catch (err) {
      console.error("blog webhook:", err);
      return res.status(500).json({ error: "could not store the article" });
    }
  });

  /* What the website's build reads. Public and read-only: it is the same
     content that is about to be published as pages anyway. */
  app.get("/api/articles.json", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT external_id, slug, title, meta_title, meta_description, subtitle,
                content_html, category, author_name, image_url, read_time,
                word_count, tags, faqs, json_ld, language_code,
                to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS published_on,
                published_at, updated_at
           FROM blog_articles
          ORDER BY published_at DESC NULLS LAST, updated_at DESC`);
      res.set("Cache-Control", "public, max-age=60");
      res.json({ count: rows.length, articles: rows });
    } catch (err) {
      console.error("blog feed read:", err);
      res.status(500).json({ error: "could not read the articles" });
    }
  });

  return { on: true };
};
