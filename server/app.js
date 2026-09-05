"use strict";
const express = require("express");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const crypto = require("node:crypto");
const path = require("node:path");
const { Collector } = require("./collector");
const {
  envelopeSchema,
  MAX_BYTES,
  ProtocolError,
  digest,
} = require("../protocol/protocol.cjs");
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
const bearer = (req) =>
  (req.get("authorization") || "").replace(/^Bearer /, "");

function createApp({
  db,
  maintainerToken = process.env.MAINTAINER_TOKEN,
  now,
  disableRateLimit = false,
  ...options
}) {
  const app = express();
  const collector = new Collector(db, { now, ...options });
  app.locals.collector = collector;
  app.disable("x-powered-by");
  const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
  if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 3)
    throw new Error("Invalid TRUST_PROXY_HOPS");
  app.set("trust proxy", proxyHops);
  app.use(helmet({ referrerPolicy: { policy: "no-referrer" } }));
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  // No request/access logger. Rate limiting retains only an ephemeral HMAC of
  // the transport address, in memory for one window; it is never analytics.
  const limiterKey = crypto.randomBytes(32);
  const makeLimiter = (limit) =>
    rateLimit({
      windowMs: 10 * 60 * 1000,
      limit,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      keyGenerator: (req) =>
        crypto
          .createHmac("sha256", limiterKey)
          .update(req.ip || "unknown")
          .digest("hex"),
      message: { error: "RATE_LIMITED" },
      validate: false,
    });
  if (!disableRateLimit) {
    app.use("/api", makeLimiter(1000));
    app.use(
      ["/api/envelopes", "/api/participant/lookup", "/api/maintainer"],
      makeLimiter(120),
    );
  }
  app.use(express.json({ limit: MAX_BYTES, strict: true, inflate: false }));
  app.get(
    "/api/health",
    wrap(async (_req, res) => {
      await db("installations").select("id").limit(1);
      res.json({ status: "ok", schema_version: "usage.v1" });
    }),
  );
  app.get("/schema/usage.v1.json", (_req, res) => res.json(envelopeSchema));
  app.post(
    "/api/envelopes",
    wrap(async (req, res) => res.json(await collector.receive(req.body))),
  );
  app.get(
    "/api/public/summary",
    wrap(async (_req, res) => res.json(await collector.summary())),
  );
  app.get(
    "/api/public/dataset",
    wrap(async (req, res) => {
      const offset = Number(req.query.offset || 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
        throw new ProtocolError("INVALID_OFFSET");
      res.json(await collector.dataset(offset));
    }),
  );
  app.get(
    "/api/public/export",
    wrap(async (req, res) => {
      res
        .type("application/x-ndjson")
        .attachment("picpeak-usage-public.ndjson");
      let offset = 0;
      do {
        const page = await collector.dataset(offset);
        for (const row of page.records) {
          if (res.destroyed) return;
          if (!res.write(`${JSON.stringify(row)}\n`))
            await new Promise((resolve) => {
              res.once("drain", resolve);
              res.once("close", resolve);
            });
        }
        offset = page.next;
      } while (offset !== null);
      res.end();
    }),
  );
  app.get(
    "/api/public/requests",
    wrap(async (_req, res) => res.json(await collector.publicFeedback())),
  );
  app.get(
    "/api/public/testimonials",
    wrap(async (_req, res) =>
      res.json(await collector.publicFeedback("testimonial")),
    ),
  );
  app.post(
    "/api/participant/lookup",
    wrap(async (req, res) => {
      if (!req.body || Object.keys(req.body).length !== 1)
        throw new ProtocolError("INVALID_LOOKUP");
      res.json(await collector.lookup(req.body.installation_id));
    }),
  );
  app.get(
    "/api/participant/session",
    wrap(async (req, res) => {
      const id = await collector.participant(bearer(req));
      res.json({
        installation_id: id,
        requests: await collector.publicFeedback("feature_request", id),
      });
    }),
  );
  app.put(
    "/api/participant/votes/:id",
    wrap(async (req, res) => {
      if (
        !req.body ||
        Object.keys(req.body).length !== 1 ||
        typeof req.body.voted !== "boolean"
      )
        throw new ProtocolError("INVALID_VOTE");
      await db.transaction(
        async (tx) => {
          // Check the session in the same transaction as the vote. Foreign keys
          // also prevent stale in-flight requests from recreating opted-out data.
          const id = await collector.participant(bearer(req), tx);
          await collector.checkQuota(
            tx,
            id,
            "browser_vote",
            100,
            collector.now(),
          );
          await collector.setVote(tx, id, req.params.id, req.body.voted);
          const packetId = crypto.randomUUID();
          await tx("operations").insert({
            packet_id: packetId,
            installation_id: id,
            action: "browser_vote",
            packet_digest: digest(packetId),
            receipt: "{}",
            day: new Date(collector.now()).toISOString().slice(0, 10),
          });
        },
        db.client.config.client === "pg"
          ? { isolationLevel: "serializable" }
          : undefined,
      );
      res.json({ ok: true });
    }),
  );
  const maintainer = (req, _res, next) => {
    if (!maintainerToken || maintainerToken.length < 32)
      return next(new ProtocolError("MAINTAINER_NOT_CONFIGURED", 503));
    if (
      !crypto.timingSafeEqual(
        Buffer.from(digest(bearer(req))),
        Buffer.from(digest(maintainerToken)),
      )
    )
      return next(new ProtocolError("MAINTAINER_AUTH_REQUIRED", 401));
    next();
  };
  app.get(
    "/api/maintainer/feedback",
    maintainer,
    wrap(async (_req, res) => {
      const rows = await db("feedback")
        .select(
          "id",
          "kind",
          "title",
          "body",
          "name",
          "allow_public",
          "allow_marketing",
          "published",
          "status",
          "created_at",
        )
        .orderBy("created_at", "desc");
      res.json(
        rows.map((r) => ({
          ...r,
          allow_public: Boolean(r.allow_public),
          allow_marketing: Boolean(r.allow_marketing),
          published: Boolean(r.published),
        })),
      );
    }),
  );
  app.patch(
    "/api/maintainer/feedback/:id",
    maintainer,
    wrap(async (req, res) =>
      res.json(await collector.moderate(req.params.id, req.body)),
    ),
  );
  app.use("/api", (_req, res) => res.status(404).json({ error: "NOT_FOUND" }));
  app.use(express.static(path.join(__dirname, "../dist"), { index: false }));
  app.get("*", (_req, res, next) =>
    res.sendFile(path.join(__dirname, "../dist/index.html"), (error) => {
      if (error) next(error);
    }),
  );
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    const status =
      error.status || (error.type === "entity.too.large" ? 413 : 500);
    // Never echo validation input, headers, database details, or feedback.
    res.status(status).json({
      error:
        error instanceof ProtocolError
          ? error.code
          : status < 500
            ? "INVALID_REQUEST"
            : "SERVICE_UNAVAILABLE",
    });
  });
  return app;
}
module.exports = { createApp };
