const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const ROOT=process.env.SCREENSHOT_DIR||fs.mkdtempSync(path.join(require('os').tmpdir(),'witt-header-capsule-')),LIVE=process.env.WEB_ROOT||path.resolve(__dirname,'../web'),STAGED=process.env.STAGED_ROOT||'',id='00000000-0000-4000-8000-000000000001';
fs.mkdirSync(ROOT,{recursive:true});
(async()=>{const browser=await chromium.launch({headless:true,args:['--no-sandbox']});try{
for(const width of (process.env.TEST_WIDTHS?process.env.TEST_WIDTHS.split(',').map(Number):[320,390,844,1280]))for(const theme of ['light','dark']){
const p=await browser.newPage({viewport:{width,height:width===844?390:844}});p.setDefaultTimeout(5000);const errors=[];p.on('pageerror',e=>errors.push(e.message));
await p.addInitScript(({id,theme})=>{if(window.top!==window)return;localStorage.setItem('wit_theme',theme);localStorage.setItem('wit_active_conversation',id);window.__calls=[];
window.__conversation={id,title:'胶囊界面验证',model:'gpt-6.1-sol',reasoning:'medium',accessMode:'danger-full-access',codexProfile:'default',messages:[],busy:false,contextUsage:{usedTokens:34000,contextWindow:100000},createdAt:new Date().toISOString()};
const send=(name,data)=>setTimeout(()=>window.DropVault?.[name]?.(JSON.stringify(data)),0);
window.WittNative={postMessage(raw){const {method,args}=JSON.parse(raw);window.__calls.push({method,args});
if(method==='requestAuthStatus')send('onAuthStatus',{initialized:true,authenticated:true,principal:{admin:true,label:'测试管理员'}});
if(method==='requestConversations')send('onConversations',{conversations:[window.__conversation]});
if(method==='requestConversation')send('onConversation',{conversation:window.__conversation});
if(method==='requestUsage')send('onUsage',{codexProfile:'default',summary:{},days:[],rateLimits:{primary:{usedPercent:28,windowDurationMins:300},secondary:{usedPercent:4,windowDurationMins:10080}}});
if(method==='requestLocalSshStatus')send('onLocalSshStatus',{connected:false});
}};
},{id,theme});
await p.route('**/*',route=>{const u=new URL(route.request().url());if(u.hostname!=='witt.test')return route.abort();const name=decodeURIComponent(u.pathname).replace(/^\/vault\//,'')||'index.html';let file=path.resolve(LIVE,name);if(!file.startsWith(LIVE+path.sep))return route.abort();const staged=STAGED&&path.join(STAGED,name);if(staged&&fs.existsSync(staged))file=staged;if(!fs.existsSync(file)||!fs.statSync(file).isFile())return route.fulfill({status:404,body:''});return route.fulfill({path:file,contentType:({'.js':'application/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[path.extname(file)]});});
await p.goto('https://witt.test/vault/index.html');await p.evaluate(()=>DropVault.nativeReady({nativeLaunch:true,workspaceFeatures:true,workspaceOperations:true,version:'3.2.5',cacheScope:'capsule-test'}));await p.locator('#bootScreen').waitFor({state:'hidden'});
await p.waitForFunction(()=>document.querySelector('#headerContextValue').textContent==='34%');
assert.equal(await p.locator('#headerQuotaValue').textContent(),'72%');assert.equal(await p.locator('#newChatButton').count(),0);
await p.waitForTimeout(500);
const fills=await p.evaluate(()=>['#headerQuotaButton','#headerContextButton'].map(s=>{const b=document.querySelector(s);return b.querySelector('.capacity-fill').getBoundingClientRect().width/b.clientWidth}));
assert(Math.abs(fills[0]-.72)<.02&&Math.abs(fills[1]-.34)<.02,'whole capsule fill does not match percentage');
const boxes=await p.evaluate(()=>['#menuButton','#capacityCapsule','#headerQuotaButton','#headerContextButton','#chatMoreButton'].map(selector=>{const n=document.querySelector(selector),r=n.getBoundingClientRect();return{selector,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,fill:getComputedStyle(n).getPropertyValue('--capacity-fill')}}));
for(const b of boxes)assert(b.left>=0&&b.right<=width+1&&b.height>=40,'header outside viewport or too small '+JSON.stringify(b));
assert(boxes[0].right<=boxes[1].left,'menu overlaps capsule');assert(boxes[1].right<=boxes[4].left,'capsule overlaps more button');assert.equal(boxes[2].fill,'72%');assert.equal(boxes[3].fill,'34%');
if(width===390||width===1280)await p.screenshot({path:ROOT+`/header-${theme}-${width}.png`});
await p.locator('#headerContextButton').click();assert(await p.locator('#contextUsageSheet').isVisible());assert.equal(await p.locator('#contextDetailPercent').textContent(),'34%');await p.keyboard.press('Shift+Tab');assert.equal(await p.evaluate(()=>document.activeElement.id),'contextUsageDone');await p.keyboard.press('Tab');assert.equal(await p.evaluate(()=>document.activeElement.id),'closeContextUsage');await p.keyboard.press('Escape');assert(await p.locator('#contextUsageSheet').isHidden());assert.equal(await p.evaluate(()=>document.activeElement.id),'headerContextButton');
await p.locator('#headerQuotaButton').click();assert(await p.locator('#profileSheet').isVisible());await p.locator('#closeProfile').click();
async function conversation(patch){await p.evaluate(patch=>{window.__conversation={...window.__conversation,...patch};DropVault.onConversation(JSON.stringify({conversation:window.__conversation}))},patch)}
async function usage(payload){await p.evaluate(payload=>DropVault.onUsage(JSON.stringify(payload)),payload)}
await usage({codexProfile:'default',rateLimits:{planType:'pro',primary:{usedPercent:90,windowDurationMins:300},secondary:{usedPercent:12,windowDurationMins:10080}}});assert.equal(await p.locator('#headerQuotaValue').textContent(),'88%');
await conversation({contextUsage:null});assert.equal(await p.locator('#headerContextValue').textContent(),'—');
await conversation({contextUsage:{usedTokens:0,contextWindow:100000}});assert.equal(await p.locator('#headerContextValue').textContent(),'0%');
await conversation({contextUsage:{usedTokens:200000,contextWindow:100000}});assert.equal(await p.locator('#headerContextValue').textContent(),'100%');
await conversation({contextUsage:{usedTokens:-1,contextWindow:100000}});assert.equal(await p.locator('#headerContextValue').textContent(),'—');
await usage({codexProfile:'default',rateLimits:{primary:{usedPercent:'bad',windowDurationMins:300}}});assert.equal(await p.locator('#headerQuotaValue').textContent(),'—');
await usage({codexProfile:'default',rateLimits:{primary:{usedPercent:100,windowDurationMins:300}}});assert.equal(await p.locator('#headerQuotaValue').textContent(),'0%');assert.equal(await p.locator('#headerQuotaButton').getAttribute('data-tone'),'danger');
await conversation({codexProfile:'claude',model:'claude:opus',contextUsage:null});assert.equal(await p.locator('#headerQuotaValue').textContent(),'—');
await conversation({codexProfile:'antigravity',model:'gemini:gemini-pro',contextUsage:{usedTokens:5000,contextWindow:10000}});
await usage({codexProfile:'antigravity',provider:'antigravity',quota:{available:true,groups:[{family:'gemini',name:'Gemini',buckets:[{window:'5h',remainingPercent:63},{window:'weekly',remainingPercent:91}]}]}});assert.equal(await p.locator('#headerQuotaValue').textContent(),'63%');assert.equal(await p.locator('#headerContextValue').textContent(),'50%');
await conversation({codexProfile:'default',model:'gpt-6.1-sol',contextUsage:{usedTokens:34000,contextWindow:100000}});await usage({codexProfile:'default',rateLimits:{primary:{usedPercent:28,windowDurationMins:300},secondary:{usedPercent:4,windowDurationMins:10080}}});
await p.locator('#menuButton').click();assert(await p.locator('#drawerNewChat').isVisible());
await p.locator('#drawerNewChat').click();assert(await p.evaluate(()=>window.__calls.some(c=>c.method==='createConversationWithProfile')),'sidebar new conversation stopped working');assert.equal(await p.locator('#headerContextValue').textContent(),'—');
assert.deepEqual(errors,[]);console.log('PASS quota, context, dialogs, navigation',width,theme);await p.close();
}
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
