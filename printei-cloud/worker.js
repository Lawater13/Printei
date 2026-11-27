import { connect } from "cloudflare:sockets";
export default { async fetch(request) {
 const path=new URL(request.url).pathname;
 const headers={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};
 if(request.method!=="GET") return new Response("Method not allowed",{status:405,headers});
 if(path==="/health") return Response.json({service:"printei-cloud",stage:"diagnostic",printerConnected:false},{headers});
 if(path==="/diagnostic"){
 let socket,timer;try{
 socket=connect({hostname:"us.mqtt.bambulab.com",port:8883},{secureTransport:"on"});
 await Promise.race([socket.opened,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("timeout")),5000)})]);
 return Response.json({tls:true,mqttAuthenticated:false,printerConnected:false},{headers});
 }catch{return Response.json({tls:false,mqttAuthenticated:false,printerConnected:false},{status:503,headers});}
 finally{clearTimeout(timer);if(socket)try{await socket.close()}catch{}}
 }
 if(path!=="/")return new Response("Not found",{status:404,headers});
 return new Response('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Printei Cloud</title><style>body{background:#15121b;color:#eee;font:16px system-ui;margin:40px}main{max-width:700px;margin:auto;background:#201d27;padding:28px;border-radius:16px}a{color:#c084fc}</style><main><h1>Printei Cloud</h1><p>Serviço experimental. Nenhuma impressora conectada.</p><p><a href="/diagnostic">Testar conexão TLS com Bambu Cloud</a></p><p>O teste não autentica nem envia comandos à impressora.</p></main></html>',{headers:{...headers,"Content-Type":"text/html; charset=utf-8"}});
 }};