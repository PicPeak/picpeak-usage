"use strict";
const express = require("express");
const helmet = require("helmet");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const crypto = require("node:crypto");
const path = require("node:path");
const { Collector } = require("./collector");
const { streamExport } = require("./exports");
const { history } = require("./history");
const { reporters, pageOptions } = require("./maintainer");
const {
  envelopeSchemas,
  CATALOGS,
  CURRENT_SCHEMA_VERSION,
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
  const collector = new Collector(db, {
    now,
    sessionSecret: process.env.SESSION_SECRET || maintainerToken,
    ...options,
  });
  app.locals.collector = collector;
  app.disable("x-powered-by");
  const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
  if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 3)
    throw new Error("Invalid TRUST_PROXY_HOPS");
  app.set("trust proxy", proxyHops);
  app.set("query parser", "simple"); // flat, explicitly validated pagination fields
  app.use(
    helmet({
      referrerPolicy: { policy: "no-referrer" },
      // The portal loads nothing from third parties: no https: wildcards.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          fontSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          upgradeInsecureRequests: [],
        },
      },
    }),
  );
  app.use((_req, res, next) => {
    res.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    );
    next();
  });
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
          .update(ipKeyGenerator(req.ip || "unknown", 56))
          .digest("hex"),
      message: { error: "RATE_LIMITED" },
    });
  if (!disableRateLimit) {
    app.use("/api", makeLimiter(1000));
    app.use(
      [
        "/api/envelopes",
        "/api/participant/lookup",
        "/api/participant/packets",
        "/api/participant/raw-export",
        "/api/participant/summary",
        "/api/participant/dataset",
        "/api/participant/export",
        "/api/participant/history",
        "/api/maintainer",
      ],
      makeLimiter(120),
    );
  }
  app.use(express.json({ limit: MAX_BYTES, strict: true, inflate: false }));
  app.get(
    "/api/health",
    wrap(async (_req, res) => {
      await db("installations").select("id").limit(1);
      res.json({ status: "ok", schema_version: CURRENT_SCHEMA_VERSION, supported_schemas: Object.keys(envelopeSchemas) });
    }),
  );
  for (const [version, schema] of Object.entries(envelopeSchemas))
    app.get(`/schema/${version}.json`, (_req, res) => res.json(schema));
  for (const [version, catalog] of Object.entries(CATALOGS))
    app.get(`/schema/features.${version.split(".")[1]}.json`, (_req, res) => res.json(catalog));
  app.post(
    "/api/envelopes",
    wrap(async (req, res) => res.json(await collector.receive(req.body))),
  );
  // Aggregate data is for participants (#1110): a lookup hash or a voting
  // session proves participation. Nothing aggregate is served anonymously.
  const reader = wrap(async (req, _res) => {
    await collector.reader(bearer(req));
  });
  const readerGuard = (req, res, next) =>
    reader(req, res).then(() => next(), next);
  app.get(
    "/api/participant/summary",
    readerGuard,
    wrap(async (_req, res) => res.json(await collector.summary())),
  );
  app.post(
    "/api/participant/history",
    readerGuard,
    wrap(async (req, res) => res.json(await history(collector, req.body, { credential: bearer(req) }))),
  );
  app.get(
    "/api/participant/dataset",
    readerGuard,
    wrap(async (req, res) => {
      const offset = Number(req.query.offset || 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
        throw new ProtocolError("INVALID_OFFSET");
      const revision = req.query.revision;
      if (
        revision !== undefined &&
        (typeof revision !== "string" || !/^\d{1,20}$/.test(revision))
      )
        throw new ProtocolError("INVALID_REVISION");
      res.json(await collector.datasetPage(offset, revision));
    }),
  );
  app.get(
    "/api/participant/export",
    readerGuard,
    wrap(async (req, res) =>
      streamExport({ res, db, collector, credential: bearer(req) }),
    ),
  );
  const feedbackCursor = (req) => {
    const value = req.query.after || "";
    if (typeof value !== "string" || (value && !/^[a-f0-9-]{36}$/.test(value)))
      throw new ProtocolError("INVALID_CURSOR");
    return value;
  };
  const feedbackResponse = (res, rows) => {
    if (rows.length === 200) res.set("X-Next-Cursor", rows.at(-1).id);
    return res.json(rows);
  };
  app.get(
    "/api/public/requests",
    wrap(async (req, res) =>
      feedbackResponse(
        res,
        await collector.publicFeedback("feature_request", null, {
          after: feedbackCursor(req),
        }),
      ),
    ),
  );
  app.get(
    "/api/public/testimonials",
    wrap(async (req, res) =>
      feedbackResponse(
        res,
        await collector.publicFeedback("testimonial", null, {
          after: feedbackCursor(req),
        }),
      ),
    ),
  );
  // Homepage consumers MUST use this feed, not the general portal feed.
  app.get(
    "/api/public/marketing-testimonials",
    wrap(async (req, res) =>
      feedbackResponse(
        res,
        await collector.publicFeedback("testimonial", null, {
          marketing: true,
          after: feedbackCursor(req),
        }),
      ),
    ),
  );
  app.post(
    "/api/participant/lookup",
    wrap(async (req, res) => {
      if (!req.body || Object.keys(req.body).length !== 1)
        throw new ProtocolError("INVALID_LOOKUP");
      if (
        typeof req.body.installation_id !== "string" ||
        !/^[a-f0-9]{64}$/.test(req.body.installation_id)
      )
        throw new ProtocolError("INVALID_LOOKUP");
      await streamExport({
        res,
        db,
        collector,
        installationId: req.body.installation_id,
      });
    }),
  );
  app.get(
    "/api/participant/raw-export",
    wrap(async (req, res) => {
      // A session can obtain its own lookup hash already; never accept a target
      // identity in a query parameter or leak credentials into URLs/access logs.
      const id = await collector.reader(bearer(req));
      await streamExport({ res, db, collector, installationId: id });
    }),
  );
  app.post(
    "/api/participant/packets",
    wrap(async (req, res) => {
      const body = req.body;
      if (
        !body ||
        Object.keys(body).some(
          (key) => !["installation_id", "after", "revision"].includes(key),
        ) ||
        (body.after !== undefined &&
          (typeof body.after !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(body.after))) ||
        (body.revision !== undefined &&
          (typeof body.revision !== "string" ||
            !/^\d{1,20}$/.test(body.revision)))
      )
        throw new ProtocolError("INVALID_LOOKUP");
      res.json(
        await collector.packetPage(
          body.installation_id,
          body.after,
          body.revision,
        ),
      );
    }),
  );
  app.get(
    "/api/participant/session",
    wrap(async (req, res) => {
      const id = await collector.participant(bearer(req));
      const requests = await collector.publicFeedback("feature_request", id, {
        after: feedbackCursor(req),
      });
      res.json({
        installation_id: id,
        requests,
        next: requests.length === 200 ? requests.at(-1).id : null,
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
  app.get("/api/maintainer/summary", maintainer,
    wrap(async (_req, res) => res.json(await collector.summary())));
  app.post("/api/maintainer/history", maintainer,
    wrap(async (req, res) => res.json(await history(collector, req.body, { maintainer: true }))));
  app.post("/api/maintainer/reporters", maintainer,
    wrap(async (req, res) => res.json(await reporters(collector, req.body))));
  app.post("/api/maintainer/packets", maintainer, wrap(async (req, res) => {
    const { installation_id, after, revision } = pageOptions(req.body, true);
    res.json(await collector.packetPage(installation_id, after, revision));
  }));
  app.post("/api/maintainer/export", maintainer, wrap(async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
        Object.keys(req.body).some((key) => key !== "installation_id") ||
        (req.body.installation_id !== undefined &&
          (typeof req.body.installation_id !== "string" || !/^[a-f0-9]{64}$/.test(req.body.installation_id))))
      throw new ProtocolError("INVALID_EXPORT_FILTER");
    await streamExport({ res, db, collector, maintainer: true, installationId: req.body.installation_id });
  }));
  app.get(
    "/api/maintainer/feedback",
    maintainer,
    wrap(async (req, res) => {
      const rows = await db("feedback")
        .select(
          "id",
          "installation_id",
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
        .where("id", ">", feedbackCursor(req))
        .orderBy("id")
        .limit(200);
      feedbackResponse(
        res,
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
  app.use(
    express.static(path.join(__dirname, "../dist"), {
      index: false,
      setHeaders(res, file) {
        // Vite hashes /assets; font files keep stable names, so shorter.
        if (/[\\/]assets[\\/]/.test(file))
          res.set("Cache-Control", "public, max-age=31536000, immutable");
        else if (/[\\/]fonts[\\/]/.test(file))
          res.set("Cache-Control", "public, max-age=2592000");
      },
    }),
  );
  app.get("*", (_req, res, next) =>
    res.sendFile(path.join(__dirname, "../dist/index.html"), (error) => {
      if (error) next(error);
    }),
  );
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.destroy();
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
