const encoder = new TextEncoder();
export const desktopStatePattern = /^[a-f0-9]{64}$/;
const callback = "http://127.0.0.1:43872/printer-cloud/callback";

async function signingKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function decodePart(part) {
  return Uint8Array.from(atob(part.replaceAll("-", "+").replaceAll("_", "/")), value => value.charCodeAt(0));
}

function decodeJSON(part) {
  return JSON.parse(new TextDecoder().decode(decodePart(part)));
}

function tokenExpiry(assertion) {
  try {
    return decodeJSON(assertion.split(".")[1]).exp * 1000;
  } catch {
    return 0;
  }
}

export async function verifyAccessAssertion(assertion, issuer, audience, fetchKeys, now = Date.now()) {
  if (!assertion || assertion.length > 12000 || !issuer || !audience) return false;
  const parts = assertion.split(".");
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const [header, payload, signature] = parts;
    const { alg, kid } = decodeJSON(header);
    const claims = decodeJSON(payload);
    const issuedFor = Array.isArray(claims.aud) ? claims.aud.includes(audience) : claims.aud === audience;
    if (alg !== "RS256" || typeof kid !== "string" || claims.iss !== issuer || !issuedFor ||
        !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now ||
        (claims.nbf != null && (!Number.isSafeInteger(claims.nbf) || claims.nbf * 1000 > now))) return false;
    const keys = await fetchKeys();
    const jwk = Array.isArray(keys) && keys.find(key => key.kid === kid && key.kty === "RSA");
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodePart(signature), encoder.encode(header + "." + payload));
  } catch {
    return false;
  }
}

export async function desktopGrant(assertion, secret, now = Date.now()) {
  if (!assertion || assertion.length > 12000) return null;
  const expires = tokenExpiry(assertion);
  if (!Number.isSafeInteger(expires) || expires <= now) return null;
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret),
    encoder.encode("printei-desktop-read-v1:" + assertion));
  return { grant: Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join(""), expires };
}

export async function verifyDesktopGrant(assertion, grant, secret, now = Date.now()) {
  if (!assertion || assertion.length > 12000 || !desktopStatePattern.test(grant ?? "")) return false;
  const expires = tokenExpiry(assertion);
  if (!Number.isSafeInteger(expires) || expires <= now) return false;
  return crypto.subtle.verify("HMAC", await signingKey(secret),
    Uint8Array.from(grant.match(/../g), byte => parseInt(byte, 16)),
    encoder.encode("printei-desktop-read-v1:" + assertion));
}

const page = (body, script, nonce, formAction = "'self'") => new Response(
  '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
  '<title>Conectar impressora</title><style>body{background:#15121b;color:#eee;font:16px system-ui;margin:28px}main{max-width:440px;margin:auto;padding:22px;border-radius:16px;background:#211b2b}h1{font-size:1.3em}label{display:block;margin:12px 0}input,button{font:inherit;padding:.45em}input{width:93%}button{background:#8546c7;color:white;border:0;border-radius:6px;margin:3px}</style><main>' +
  body + '</main><script nonce="' + nonce + '">' + script + '</script></html>', {
    headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": formAction === callback ? "origin" : "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-" +
        nonce + "'; frame-ancestors 'none'; base-uri 'none'; form-action " + formAction
    }
  });

export function desktopStart(state) {
  const nonce = crypto.randomUUID();
  return page(`<h1>Conectar impressora</h1><form id="pair" action="/desktop/connect" method="post" autocomplete="off">
    <input type="hidden" name="state" value="${state}">
    <label>Chave privada do Printei <input id="key" name="key" type="password" required maxlength="1024"></label>
    <button>Autorizar leitura no aplicativo</button></form>
    <form id="bambu" hidden autocomplete="off">
      <label>E-mail Bambu Lab <input id="email" type="email" required maxlength="254"></label>
      <button id="send" type="button">Solicitar código</button>
      <label>Código de e-mail <input id="code" inputmode="numeric" pattern="[0-9]{6}" required></label>
      <button>Vincular e concluir</button></form><p id="status" role="status"></p>`, `
    const pair=document.getElementById("pair"), bambu=document.getElementById("bambu");
    const key=document.getElementById("key"), email=document.getElementById("email"), code=document.getElementById("code");
    const status=document.getElementById("status");
    async function call(path,data) {
      const res=await fetch(path,{method:"POST",redirect:"error",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({...data,key:key.value})});
      const result=await res.json();
      if(!res.ok) throw Object.assign(new Error(result.error),{status:res.status});
      return result;
    }
    async function action(run){
      const buttons=document.querySelectorAll("button");buttons.forEach(b=>b.disabled=true);
      try{await run()}catch(e){status.textContent=e.message}finally{buttons.forEach(b=>b.disabled=false)}
    }
    pair.onsubmit=e=>{e.preventDefault();action(async()=>{
      try{await call("/bambu/session",{});pair.submit()}
      catch(e){if(e.status!==401)throw e;bambu.hidden=false;status.textContent="Vincule a Bambu Cloud para continuar."}
    })};
    document.getElementById("send").onclick=()=>{if(email.reportValidity())action(async()=>{
      status.textContent=(await call("/bambu/test",{email:email.value})).message;
    })};
    bambu.onsubmit=e=>{e.preventDefault();action(async()=>{
      await call("/bambu/test",{email:email.value,code:code.value,save:true});code.value="";pair.submit();
    })};`, nonce);
}

export function desktopFinish(state, assertion, { grant, expires }) {
  const nonce = crypto.randomUUID();
  const hidden = (name, value) => '<input type="hidden" name="' + name + '" value="' +
    String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]) + '">';
  return page('<h1>Concluindo conexão</h1><form id="done" method="post" action="' + callback + '">' +
    hidden("state", state) + hidden("assertion", assertion) + hidden("grant", grant) + hidden("expires", expires) +
    '<button>Voltar ao Printei</button></form>', 'document.getElementById("done").submit();', nonce, callback);
}
