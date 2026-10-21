"use strict";
// Isolated development fixture, never a production launcher. State and TLS
// material must be supplied in a new private directory by the test operator.
const fs=require("node:fs"),path=require("node:path"),http=require("node:http"),https=require("node:https"),net=require("node:net"),crypto=require("node:crypto");
const {spawn}=require("node:child_process");
const repo=path.resolve(__dirname,".."),dir=process.env.ASSIST_TEST_DIR;
if (!dir || !fs.existsSync(path.join(dir,"tls-key.pem"))) throw Error("ASSIST_TEST_DIR must name the prepared isolated test directory");
const {AuthService}=require("../backend/auth-service");
const dirs={auth:"auth",users:"users",chat:"chat",files:"files",tasks:"tasks",images:"images",work:"work"};
for(const d of Object.values(dirs))fs.mkdirSync(path.join(dir,d),{recursive:true,mode:0o700});
const token=crypto.randomBytes(32).toString("base64url"),userId=crypto.randomUUID(),deviceId=crypto.randomUUID();
fs.writeFileSync(path.join(dir,"api-token"),token,{mode:0o600});fs.writeFileSync(path.join(dir,"devices.json"),'{"devices":[]}',{mode:0o600});
const auth=new AuthService({dir:path.join(dir,"auth")}),data=auth.read();
data.devices.push({id:deviceId,userId,admin:true,label:"Assist 开发验收",tokenHash:crypto.createHash("sha256").update(token).digest("hex"),lastSeenAt:new Date().toISOString()});auth.write(data);
const allocation=net.createServer();allocation.listen(0,"127.0.0.1",()=>{const backendPort=allocation.address().port;allocation.close(()=>start(backendPort));});
function start(backendPort){
 const env={...process.env,DROP_VAULT_PORT:String(backendPort),DROP_VAULT_DATA_DIR:path.join(dir,"files"),DROP_VAULT_TASK_DIR:path.join(dir,"tasks"),DROP_VAULT_CHAT_DIR:path.join(dir,"chat"),DROP_VAULT_IMAGE_DIR:path.join(dir,"images"),DROP_VAULT_USERS_DIR:path.join(dir,"users"),DROP_VAULT_AUTH_DIR:path.join(dir,"auth"),DROP_VAULT_TOKEN_FILE:path.join(dir,"api-token"),DROP_VAULT_CODEX_WORKDIR:path.join(dir,"work"),WITT_DEVICE_CONFIG:path.join(dir,"devices.json"),WITT_REMOTE_WORKSPACE_DIR:path.join(dir,"remote-workspaces"),WITT_WORKER_SOCKET:path.join(dir,"no-worker.sock"),WITT_RUNTIME_PROFILES_FILE:path.join(dir,"runtime-profiles.json"),WITT_DEVELOPMENT_ROOT:path.join(dir,"development")};
 const log=fs.openSync(path.join(dir,"backend.log"),"a",0o600);
 const backend=spawn(process.execPath,[path.join(repo,"backend/server.js")],{cwd:repo,env,stdio:["ignore",log,log]});
 backend.on("exit",code=>{if(!stopping){console.error("isolated backend exited",code);process.exitCode=1;stop();}});
 const tls=https.createServer({key:fs.readFileSync(path.join(dir,"tls-key.pem")),cert:fs.readFileSync(path.join(dir,"tls-cert.pem"))},(req,res)=>{
  const parsed=new URL(req.url,"https://localhost");
  if(req.method==="GET"&&(parsed.pathname==="/"||parsed.pathname.startsWith("/vault/"))){
   const relative=parsed.pathname==="/"?"index.html":parsed.pathname.slice(7),file=path.resolve(repo,"web",relative),root=path.join(repo,"web")+path.sep;
   if(!file.startsWith(root)){res.writeHead(403);res.end();return;}
   const mime={".html":"text/html; charset=utf-8",".js":"application/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".webp":"image/webp",".woff2":"font/woff2"}[path.extname(file)]||"application/octet-stream";
   fs.stat(file,(err,st)=>{if(err||!st.isFile()){res.writeHead(404);res.end();return;}res.writeHead(200,{"Content-Type":mime});fs.createReadStream(file).pipe(res);});return;
  }
  const target=req.url.replace(/^\/vault-api(?=\/)/,"");
  const proxy=http.request({host:"127.0.0.1",port:backendPort,path:target,method:req.method,headers:{...req.headers,"x-forwarded-proto":"https"}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
  proxy.on("error",()=>{res.writeHead(502);res.end();});req.pipe(proxy);
 });
 tls.on("upgrade",(req,socket,head)=>{
  const upstream=net.connect(backendPort,"127.0.0.1",()=>{
   upstream.write(`${req.method} ${req.url.replace(/^\/vault-api(?=\/)/,"")} HTTP/1.1\r\n${Object.entries(req.headers).map(([k,v])=>`${k}: ${v}`).join("\r\n")}\r\n\r\n`);
   if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);
  });upstream.on("error",()=>socket.destroy());socket.on("error",()=>upstream.destroy());socket.on("close",()=>upstream.destroy());
 });
 let stopping=false;
 function stop(){if(stopping)return;stopping=true;backend.kill("SIGTERM");tls.close();tls.closeAllConnections();fs.closeSync(log);setTimeout(()=>process.exit(),500).unref();}
 process.on("SIGTERM",stop);process.on("SIGINT",stop);
 tls.listen(0,"127.0.0.1",async()=>{
  for(let n=0;n<100;n++){try{const r=await fetch(`http://127.0.0.1:${backendPort}/health`);if(r.ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const metadata={tlsPort:tls.address().port,backendPort,userId,deviceId,pid:process.pid};
  fs.writeFileSync(path.join(dir,"dev-server.json"),JSON.stringify(metadata),{mode:0o600});
  console.log(JSON.stringify(metadata));
 });
}
