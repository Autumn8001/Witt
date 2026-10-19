"use strict";
const { AssistSessions, isAssist } = require("./session-service");
const { createAssistRoutes } = require("./routes");

// Host contract: existing WSS Gateway + WorkspaceStore + HTTP/auth/chat hooks.
// No model planning, provider routing, device installation or UI is owned here.
function createRemoteAssist(options) {
  const {gateway}=options;
  const sessions=new AssistSessions(options);
  const priorGuard=gateway.dispatcher.authorizeCommand,priorDisconnect=gateway.onDisconnect,priorConnect=gateway.canConnect;
  gateway.dispatcher.authorizeCommand=(id,command)=>{priorGuard?.(id,command);sessions.guardDevice(id,command);};
  gateway.onDisconnect=id=>{priorDisconnect?.(id);sessions.disconnected(id);};
  gateway.canConnect=id=>{
    if (!priorConnect(id)) return false;
    if (!isAssist(id)) return true;
    const s=sessions.devices.get(id);
    return Boolean(s && s.state==="active" && sessions.now()<s.expires_at);
  };
  return {sessions,transport:sessions.transport(),routes:createAssistRoutes({...options,sessions}),close:()=>sessions.close()};
}
module.exports={createRemoteAssist};
