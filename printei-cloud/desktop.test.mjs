import test from "node:test";
import assert from "node:assert/strict";
import { desktopFinish, desktopGrant, verifyDesktopGrant, verifyAccessAssertion } from "./desktop.js";

const accessToken = exp => "header." + Buffer.from(JSON.stringify({ exp })).toString("base64url") + ".signature";

test("autorização desktop é vinculada ao JWT do Access, ao secret e à validade", async () => {
  const token = accessToken(200);
  const grant = await desktopGrant(token, "test-key", 100_000);
  assert.equal(grant.expires, 200_000);
  assert.equal(await verifyDesktopGrant(token, grant.grant, "test-key", 100_000), true);
  assert.equal(await verifyDesktopGrant(token, grant.grant, "another-key", 100_000), false);
  assert.equal(await verifyDesktopGrant(accessToken(300), grant.grant, "test-key", 100_000), false);
  assert.equal(await verifyDesktopGrant(token, grant.grant, "test-key", 200_000), false);
  assert.equal(await desktopGrant(token, "test-key", 200_000), null);
  assert.equal(await desktopGrant("", "test-key", 100_000), null);
});

test("retorno envia a autorização somente no corpo para um destino loopback fixo", async () => {
  const state = "ab".repeat(32);
  const token = accessToken(200);
  const grant = await desktopGrant(token, "test-key", 100_000);
  const response = desktopFinish(state, token, grant);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "origin");
  const body = await response.text();
  assert.match(body, /method="post" action="http:\/\/127\.0\.0\.1:43872\/printer-cloud\/callback"/);
  assert.match(body, new RegExp('name="state" value="' + state + '"'));
  assert.doesNotMatch(body, /test-key/);
});

test("verifica assinatura RS256, emissor, audiência e expiração do Access", async () => {
  const issuer = "https://test.cloudflareaccess.com", audience = "experimental";
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
    true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "test" };
  const part = object => Buffer.from(JSON.stringify(object)).toString("base64url");
  const body = part({ alg: "RS256", kid: "test" }) + "." + part({ iss: issuer, aud: [audience], exp: 200 });
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(body));
  const jwt = body + "." + Buffer.from(signature).toString("base64url");
  const keys = async () => [jwk];
  assert.equal(await verifyAccessAssertion(jwt, issuer, audience, keys, 100_000), true);
  assert.equal(await verifyAccessAssertion(jwt, issuer, "production", keys, 100_000), false);
  assert.equal(await verifyAccessAssertion(jwt, "https://other.test", audience, keys, 100_000), false);
  assert.equal(await verifyAccessAssertion(jwt, issuer, audience, keys, 200_000), false);
  assert.equal(await verifyAccessAssertion(body + ".forged", issuer, audience, keys, 100_000), false);
});
