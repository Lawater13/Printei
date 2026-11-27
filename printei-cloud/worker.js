import { connect } from "cloudflare:sockets";
export default { async fetch(request, env) {
 const path=new URL(request.url).pathname;
 const headers={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};
 if(path==="/bambu/test"){
 if(request.method!=="POST" || request.headers.get("Origin")!==new URL(request.url).origin) return Response.json({error:"Requisição inválida"},{status:403,headers});
 if(!env.PRINTEI_ADMIN_KEY) return Response.json({error:"Configure PRINTEI_ADMIN_KEY nas variáveis secretas do Worker."},{status:503,headers});
 const body=await request.json().catch(()=>null);
 if(!body || typeof body.key!=="string" || body.key!==env.PRINTEI_ADMIN_KEY) return Response.json({error:"Chave de acesso inválida"},{status:403,headers});
 const email=String(body.email||"").trim(),code=String(body.code||"").trim();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254|| (code&&!/^\d{6}$/.test(code)))return Response.json({error:"Confira o e-mail e o código de seis dígitos."},{status:400,headers});
 try{
 const endpoint=code?"login":"sendemail/code";
 const upstream=await fetch("https://api.bambulab.com/v1/user-service/user/"+endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(code?{account:email,code}:{email,type:"codeLogin"}),redirect:"manual",signal:AbortSignal.timeout(20000)});
 if(upstream.status>=300&&upstream.status<400)return Response.json({error:"A API Bambu respondeu com redirecionamento. Não seguimos redirecionamentos de credenciais.",upstreamStatus:upstream.status},{status:502,headers});
 const result=await upstream.json().catch(()=>null);
 if(!upstream.ok||!result)return Response.json({error:"Bambu Cloud recusou a solicitação ou retornou uma resposta incompatível.",upstreamStatus:upstream.status},{status:502,headers});
 if(!code && result.code!=null && ![0,200,"0","200"].includes(result.code))return Response.json({error:"A Bambu retornou um código de aplicação diferente de sucesso.",applicationCode:typeof result.code==="number"?result.code:null},{status:502,headers});
 if(!code)return Response.json({message:"Solicitação enviada. Confira se o código chegou ao e-mail.",authenticated:false},{headers});
 if(typeof result.accessToken!=="string")return Response.json({error:"A Bambu Cloud não retornou um token. Confira o código ou o método de autenticação."},{status:401,headers});
 const devices=await fetch("https://api.bambulab.com/v1/iot-service/api/user/bind",{headers:{Authorization:"Bearer "+result.accessToken},redirect:"manual",signal:AbortSignal.timeout(20000)});
 const d=await devices.json().catch(()=>null);
 const list=Array.isArray(d?.devices)?d.devices:null;
 return Response.json({authenticated:true,deviceLookup:devices.ok&&list!==null,devices:devices.ok&&list?list.map(x=>({name:String(x.name||x.dev_name||"Impressora"),model:String(x.dev_model_name||x.model||""),online:typeof x.online==="boolean"?x.online:null})):[],message:"Teste de autenticação concluído. O token não foi armazenado."},{headers});
 }catch(e){return Response.json({error:"Falha de comunicação com a Bambu Cloud.",stage:code?"verificacao":"solicitacao",category:e?.name==="TimeoutError"||e?.name==="AbortError"?"timeout":e?.name==="TypeError"?"network":"runtime"},{status:502,headers});}
 }
 if(request.method!=="GET") return new Response("Method not allowed",{status:405,headers});
 if(path==="/health") return Response.json({service:"printei-cloud",stage:"auth-diagnostic-v3",printerConnected:false},{headers});
 if(path==="/diagnostic"){
 let socket,timer;try{
 socket=connect({hostname:"us.mqtt.bambulab.com",port:8883},{secureTransport:"on"});
 await Promise.race([socket.opened,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("timeout")),5000)})]);
 return Response.json({tls:true,mqttAuthenticated:false,printerConnected:false},{headers});
 }catch{return Response.json({tls:false,mqttAuthenticated:false,printerConnected:false},{status:503,headers});}
 finally{clearTimeout(timer);if(socket)try{await socket.close()}catch{}}
 }
 if(path!=="/")return new Response("Not found",{status:404,headers});
 return new Response('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Printei Cloud</title><style>body{background:#15121b;color:#eee;font:16px system-ui;margin:40px}main{max-width:700px;margin:auto;background:#201d27;padding:28px;border-radius:16px}a{color:#c084fc}</style><main><h1>Printei Cloud</h1><p>Serviço experimental. Nenhuma impressora conectada.</p><p><a href="/diagnostic">Testar conexão TLS com Bambu Cloud</a></p><p>O teste TLS não autentica nem envia comandos à impressora.</p><hr><h2>Vincular conta — teste v3</h2><form id="auth"><p><label>Chave privada do Printei <input id="key" type="password" required autocomplete="off"></label></p><p><label>E-mail Bambu Lab <input id="email" type="email" required autocomplete="email"></label></p><p><button type="button" id="send">Solicitar código</button></p><p><label>Código de e-mail <input id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label></p><button type="submit">Testar autenticação</button></form><pre id="result" style="white-space:pre-wrap"></pre><script>const f=document.getElementById("auth"),out=document.getElementById("result");async function run(verify){if(!f.reportValidity())return;const code=verify?document.getElementById("code").value.trim():"";if(verify&&!/^[0-9]{6}$/.test(code)){out.textContent="Informe seis dígitos.";return}const buttons=f.querySelectorAll("button");buttons.forEach(b=>b.disabled=true);out.textContent="Consultando Bambu Cloud...";try{const r=await fetch("/bambu/test",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:document.getElementById("key").value,email:document.getElementById("email").value,code})});out.textContent=JSON.stringify(await r.json(),null,2)}catch{out.textContent="Falha na solicitação."}finally{buttons.forEach(b=>b.disabled=false);if(verify)document.getElementById("code").value=""}}document.getElementById("send").onclick=()=>run(false);f.onsubmit=e=>{e.preventDefault();run(true)}</script></main></html>',{headers:{...headers,"Content-Type":"text/html; charset=utf-8"}});
 }};