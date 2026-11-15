const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=process.env.SCREENSHOT_DIR||fs.mkdtempSync(path.join(require('os').tmpdir(),'witt-device-layout-'));
const live=process.env.WEB_ROOT||path.resolve(__dirname,'../web');
const stage=process.env.STAGED_ROOT||'';
fs.mkdirSync(root,{recursive:true});
(async()=>{const browser=await chromium.launch({headless:true,args:['--no-sandbox']});try{
for(const width of [320,390,412,844,1280])for(const theme of ['light','dark']){
const p=await browser.newPage({viewport:{width,height:width===844?390:880}});
await p.route('**/*',route=>{const u=new URL(route.request().url());if(u.hostname!=='witt.test')return route.abort();let file=path.join(live,u.pathname.replace(/^\/vault\//,''));const staged=stage&&path.join(stage,path.basename(file));if(staged&&fs.existsSync(staged))file=staged;if(!file.startsWith(live+path.sep)&&!(stage&&file.startsWith(stage+path.sep)))return route.abort();if(!fs.existsSync(file)||!fs.statSync(file).isFile()||file.endsWith('.js'))return route.abort();return route.fulfill({path:file});});
await p.goto('https://witt.test/vault/index.html');
await p.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.querySelector('#bootScreen')?.remove();document.querySelector('#authGate')?.remove();const sheet=document.querySelector('#adminSettingsSheet');sheet.classList.add('open');sheet.setAttribute('aria-hidden','false');
const list=document.querySelector('#deviceList');for(const [i,name] of ['Xiaomi 2311DRK48C','开放版登记服务（服务器内部）','开放版 Xiaomi 23013RK75C','OPPO PHN110（大阪 · 测试设备）','超长设备名称用于验证窄屏下自动换行和按钮完整显示'.repeat(3),'A'.repeat(200),'已经停止的设备',...Array.from({length:12},(_,i)=>'测试手机 '+(i+1))].entries()){
const row=document.createElement('article');row.className='device-row';const icon=document.createElement('span');icon.textContent='⌁';const info=document.createElement('div'),nameNode=document.createElement('strong'),last=document.createElement('small');nameNode.textContent=name;last.textContent=i===6?'已停止访问':'最近活跃：20:09';info.append(nameNode,last);row.append(icon,info);if(i!==6){const b=document.createElement('button');b.textContent='停止';row.append(b)}list.append(row)}
},theme);await p.waitForTimeout(400);
const results=await p.evaluate(()=>{const list=document.querySelector('#deviceList'),admin=document.querySelector('#deviceAdmin');const r=list.getBoundingClientRect();return {list:{x:r.x,right:r.right,w:r.width,client:list.clientWidth,scroll:list.scrollWidth},admin:{client:admin.clientWidth,scroll:admin.scrollWidth},rows:[...list.children].map(n=>{const r=n.getBoundingClientRect(),b=n.querySelector('button')?.getBoundingClientRect(),strong=n.querySelector('strong'),s=getComputedStyle(strong);return {left:r.left,right:r.right,w:r.width,client:n.clientWidth,scroll:n.scrollWidth,button:b?{left:b.left,right:b.right,width:b.width}:null,whiteSpace:s.whiteSpace}})}});
if(process.env.OBSERVE){console.log(width,theme,JSON.stringify(results));if(width===390&&theme==='light')await p.screenshot({path:root+'/before.png'});await p.close();continue}
assert(results.admin.scroll<=results.admin.client+1,'scroll container horizontally overflows');assert(results.list.scroll<=results.list.client+1,'grid overflows');
for(const row of results.rows){assert(row.left>=results.list.x-1&&row.right<=results.list.right+1,'card escapes list');assert(row.scroll<=row.client+1,'card content overflows');assert.equal(row.whiteSpace,'normal');if(row.button){assert(row.button.right<=row.right-10,'button clipped');assert(row.button.width>=44,'button too narrow')}}
const last=p.locator('.device-row').last();await last.scrollIntoViewIfNeeded();assert(await last.isVisible());await p.locator('#deviceAdmin').evaluate(n=>n.scrollTop=0);if(width===390||width===844)await p.screenshot({path:root+`/after-${theme}-${width}.png`});console.log('PASS',width,theme);await p.close();
}
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
