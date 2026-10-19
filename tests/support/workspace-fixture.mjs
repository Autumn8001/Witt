// Test-only HTTP transport. Never proxies or contacts a production service.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID} from "node:crypto";
const webDir=fileURLToPath(new URL("../../web/",import.meta.url));
const mimeTypes={".html":"text/html; charset=utf-8",".css":"text/css",".js":"application/javascript",".svg":"image/svg+xml",".png":"image/png",".webp":"image/webp",".json":"application/json",".ttf":"font/ttf"};
export const ids = {
  one: "00000000-0000-4000-8000-000000000001",
  two: "00000000-0000-4000-8000-000000000002",
  three: "00000000-0000-4000-8000-000000000003",
};
const now = new Date().toISOString();
export const makeConversation = (id, title, project, lastMessage, hasAttachments = false) => ({
  id, title, project, lastMessage, hasAttachments, updatedAt: now,
  model: "grok-4.7-high", reasoning: "medium", accessMode: "danger-full-access",
  harness: "grok-build", workDir: "", messages: [], taskStatus: { state: "idle", label: "已完成" },
});

export async function startWorkspaceFixture({port=0,admin=true}={}){
const requests=[];
let conversations = [];
let nextId = 10;
const eventStreams = new Map();

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, "http://localhost");
  const pathname = requestUrl.pathname;
  requests.push({method:req.method,path:pathname});

  if (pathname === "/__test/seed" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    conversations = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return sendJson(res, { ok: true });
  }
  if (pathname === "/vault-api/version.json" || pathname === "/vault/version.json" || pathname === "/version.json") {
    return sendJson(res, { ok: true, version: "3.2.7", frontendSha: "abcdef" });
  }
  if (pathname === "/vault-api/auth/status") {
    return sendJson(res, { authenticated: true, admin, principal: { admin, label: "测试账号" }, clientMode: "browser" });
  }
  if (pathname === "/vault-api/chat/capabilities") {
    return sendJson(res, {
      models: [
        { id: "grok-4.7-high", name: "Grok 4.7 High", harness: "grok-build", reasoning: ["low", "medium", "high", "ultra"] },
        { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", harness: "codex", reasoning: ["low", "medium", "high", "ultra"] },
      ],
      harnesses: [{ id: "grok-build", name: "Grok Build" }, { id: "codex", name: "Codex" }],
      runtime: { codex:{available:true}, "grok-build":{available:true} },
    });
  }
  if (/^\/vault-api\/chat\/conversations\/[^/]+\/events$/.test(pathname)) {
    const id = pathname.split("/")[4];
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": ready\n\n");
    const streams = eventStreams.get(id) || new Set();
    streams.add(res);
    eventStreams.set(id, streams);
    req.on("close", () => {
      streams.delete(res);
      if (!streams.size) eventStreams.delete(id);
    });
    return;
  }
  if (pathname === "/vault-api/chat/conversations" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const id = `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
    const conversation = {
      ...makeConversation(id, "新对话", "未分组", ""),
      model: body.model || "grok-4.7-high",
      reasoning: body.reasoning || "medium",
      accessMode: body.accessMode || "danger-full-access",
      workDir: body.workDir || "",
      codexProfile: body.codexProfile || "default",
    };
    conversations.unshift(conversation);
    return sendJson(res, { conversation });
  }
  if (pathname === "/vault-api/chat/conversations" && req.method === "GET") {
    const query = (requestUrl.searchParams.get("q") || "").trim().toLocaleLowerCase();
    const project = requestUrl.searchParams.get("project") || "";
    const attachments = requestUrl.searchParams.get("attachments") === "1";
    const results = conversations.filter((item) =>
      (!query || `${item.title} ${item.lastMessage || ""}`.toLocaleLowerCase().includes(query)) &&
      (!project || item.project === project) && (!attachments || item.hasAttachments));
    return sendJson(res, { conversations: results });
  }
  if (/^\/vault-api\/chat\/conversations\/[^/]+\/messages$/.test(pathname) && req.method === "POST") {
    const id = pathname.split("/")[4];
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) return sendJson(res, { error: "Conversation not found" }, 404);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const createdAt = new Date().toISOString();
    conversation.messages = [
      ...(conversation.messages || []),
      { id: `user-${Date.now()}`, role: "user", text: body.text || "", createdAt, status: "completed" },
      { id: `assistant-${Date.now()}`, role: "assistant", text: "Mock assistant 已收到并完成这条消息。", createdAt, status: "completed" },
    ];
    conversation.lastMessage = "Mock assistant 已收到并完成这条消息。";
    conversation.taskStatus = { state: "completed", label: "执行完成" };
    conversation.updatedAt = createdAt;
    const result = { conversation, clientRequestId: body.clientRequestId || "" };
    for (const stream of eventStreams.get(id) || []) {
      stream.write(`event: snapshot\ndata: ${JSON.stringify({ conversation })}\n\n`);
    }
    return sendJson(res, result);
  }
  if(/\/stream\//.test(pathname)){
    const conversation=conversations.find(item=>item.id===pathname.split("/")[4]);
    const entry=conversation?.messages.flatMap(item=>item.stream||[]).find(item=>item.id===pathname.split("/").at(-1));
    return entry?sendJson(res,{entry}):sendJson(res,{error:"fixture entry not found"},404);
  }
  if (pathname.startsWith("/vault-api/chat/conversations/")) {
    const id = pathname.split("/")[4];
    const conversation = conversations.find((item) => item.id === id);
    if(conversation&&req.method==="PATCH"){const chunks=[];for await(const chunk of req)chunks.push(chunk);Object.assign(conversation,JSON.parse(Buffer.concat(chunks).toString("utf8")));}
    return conversation
      ? sendJson(res, { conversation })
      : sendJson(res, { error: "Conversation not found" }, 404);
  }
  if(pathname==="/vault-api/runtime/profiles")return sendJson(res,{profiles:[{id:"grok-main",name:"Grok Build",harness:"grok-build",model:"grok-4.7-high",reasoning:"medium"}]});
  if(pathname==="/vault-api/servers/overview")return sendJson(res,{services:[]});
  if(pathname==="/vault-api/chat/workspace-overview")return sendJson(res,{projects:[],services:[]});
  if(pathname==="/vault-api/customer-devices")return sendJson(res,{devices:[]});
  if(pathname==="/vault-api/remote-workspaces/options")return sendJson(res,{devices:[]});
  if(pathname==="/vault-api/providers/cpa/quotas")return sendJson(res,{ok:true,models:[]});
  if(pathname==="/vault-api/files"&&req.method==="POST"){
    for await(const chunk of req){};
    return sendJson(res,{file:{id:randomUUID(),name:decodeURIComponent(req.headers["x-file-name"]||"fixture.png"),type:req.headers["x-file-type"]}});
  }
  if (pathname.startsWith("/vault-api/")) return sendJson(res, { ok: true });

  let filePath = pathname.replace(/^\/vault/, "") || "/index.html";
  if (filePath === "/") filePath = "/index.html";
  filePath = path.resolve(webDir, "." + filePath);
  if(!filePath.startsWith(webDir))return sendJson(res,{error:"invalid path"},404);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  console.error("Missing resource requested:", req.url);
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});


await new Promise(resolve=>server.listen(port,"127.0.0.1",resolve));
const url=`http://127.0.0.1:${server.address().port}/vault/`;
return {server,url,requests,close:async()=>{for(const streams of eventStreams.values())for(const stream of streams)stream.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
