"use strict";
// Exercises the shipped image, including its native SQLite binding, under the
// production hardening flags. Only uniquely named synthetic resources are used.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const p = require("../protocol/protocol.cjs");
const image = process.argv[2] || "picpeak-usage:security-check";
const name = `picpeak-usage-smoke-${crypto.randomUUID()}`;
const volume = `${name}-data`;
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();

async function main() {
  let created = false;
  let volumeCreated = false;
  try {
    docker(
      "volume",
      "create",
      "--label",
      "picpeak.usage.test=runtime-smoke",
      volume,
    );
    volumeCreated = true;
    docker(
      "create",
      "--name",
      name,
      "--label",
      "picpeak.usage.test=runtime-smoke",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=128",
      "--memory=512m",
      "--cpus=1",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16m",
      "--mount",
      `type=volume,source=${volume},target=/app/storage`,
      "-p",
      "127.0.0.1::3190",
      "-e",
      "TRUST_PROXY_HOPS=0",
      "-e",
      "MAINTAINER_TOKEN=synthetic-runtime-smoke-only-1234567890",
      image,
    );
    created = true;
    docker("start", name);
    let base = `http://${docker("port", name, "3190/tcp")}`;
    const healthy = async () => {
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(`${base}/api/health`)).ok) return;
        } catch {}
        await delay(200);
      }
      throw new Error("Runtime did not become healthy");
    };
    await healthy();
    const inspection = JSON.parse(docker("inspect", name))[0];
    assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(inspection.HostConfig.CapDrop, ["ALL"]);
    docker(
      "exec",
      name,
      "/nodejs/bin/node",
      "-e",
      `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      assert.equal(process.getuid(), 1000);
      for (const path of ['/bin/sh', '/bin/bash', '/usr/bin/npm', '/usr/local/bin/npm', '/usr/local/lib/node_modules/npm']) assert.equal(fs.existsSync(path), false, path);
      assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /CapEff:\\s+0+\\n/);
    `,
    );
    const identity = p.generateIdentity();
    const send = async (action, sequence, payload = {}) => {
      const response = await fetch(`${base}/api/envelopes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          p.signPacket(
            p.makePacket(identity, action, sequence, payload),
            identity,
          ),
        ),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    await send("register", 0, { consent_version: "usage-consent.v2" });
    const now = new Date().toISOString();
    await send("report", 1, {
      picpeak_version: "1.0.0",
      report_date: now.slice(0, 10),
      generated_at: now,
      gallery_layouts: ["grid"],
      features: Object.fromEntries(
        Object.entries(p.emptyFeatures()),
      ),
    });
    const session = await send("session", 2);
    assert.match(session.session_token, /^ppus_[a-f0-9]{64}$/);
    docker("restart", name);
    // Docker may reassign an automatically published host port on restart.
    base = `http://${docker("port", name, "3190/tcp")}`;
    await healthy();
    const headers = { Authorization: `Bearer ${identity.installation_id}` };
    assert.equal(
      (
        await (
          await fetch(`${base}/api/participant/summary`, { headers })
        ).json()
      ).installations,
      1,
    );
    const raw = await (
      await fetch(`${base}/api/participant/raw-export`, { headers })
    ).json();
    assert.equal(raw.packets.length, 1);
    assert.equal(raw.export_receipt.packet_count, 1);
    await send("delete", 0);
    assert.equal(
      (await fetch(`${base}/api/participant/summary`, { headers })).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${base}/api/participant/session`, {
          headers: { Authorization: `Bearer ${session.session_token}` },
        })
      ).status,
      401,
    );
    console.log(
      "PASS: hardened SQLite runtime, persistence/restart, raw export, session and opt-out",
    );
  } catch (error) {
    if (created) console.error(docker("logs", name));
    throw error;
  } finally {
    if (created) docker("rm", "-f", name);
    if (volumeCreated) docker("volume", "rm", volume);
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
