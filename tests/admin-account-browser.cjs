const {chromium}=require('playwright');
const {AuthService}=require('../backend/auth-service');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chloe-auth-browser-'));
const root=path.resolve(__dirname,'../web');
const out=process.env.CHLOE_UI_OUTPUT; if(out)fs.mkdirSync(out,{recursive:true});
const auth=new AuthService({dir,sendJson(res,status,body,headers={}){res.finish({status,json:body,headers});},readJsonBody(req,max,cb){cb(null,req.body);}});
(async()=>{
 const invite=auth.initialize('test-only-admin-credential-long');
 const desktop=auth.activate({inviteCode:invite.code,deviceId:'11111111-1111-4111-8111-111111111111'});
 const browser=await chromium.launch({headless:true});
 try{
  async function setup(width,token){
   const context=await browser.newContext({viewport:{width,height:900}});
   if(token)await context.addCookies([{name:'witt_session',value:token,domain:'chloe.test',path:'/vault-api/',secure:true,httpOnly:true,sameSite:'Strict'}]);
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('https://chloe.test/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.pathname.startsWith('/vault/')){
     const file=path.join(root,decodeURIComponent(url.pathname.slice(7)));
     if(file.startsWith(root+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile())return route.fulfill({path:file});
     return route.fulfill({json:{}});
    }
    const cookies=await context.cookies(request.url());
    const principal=auth.authenticateToken(cookies.find(c=>c.name==='witt_session')?.value);
    const local=new URL('http://localhost'+url.pathname.slice('/vault-api'.length));
    if(local.pathname.startsWith('/auth/')||local.pathname.startsWith('/admin/')){
     const response=await new Promise(resolve=>{
      const handled=auth.handle({method:request.method(),headers:request.headers(),body:request.postData()?request.postDataJSON():{}},{finish:resolve},local,principal);
      if(!handled)resolve({status:principal?404:401,json:{error:'unauthorized'}});
     });return route.fulfill(response);
    }
    let body={};
    if(url.pathname.endsWith('/chat/conversations'))body={conversations:[]};
    else if(url.pathname.endsWith('/chat/capabilities'))body={models:[{id:'grok-4.7-high',displayName:'Grok',reasoningEfforts:[{id:'high'}]}],accessModes:['workspace-write','danger-full-access'],runtime:{},support:{}};
    else if(url.pathname.endsWith('/runtime/profiles'))body={profiles:[]};
    else if(url.pathname.endsWith('/remote-assist/sessions'))body={sessions:[]};
    return route.fulfill({json:body});
   });
   await page.goto('https://chloe.test/vault/index.html');await page.waitForTimeout(700);
   return {context,page,errors};
  }
  const pc=await setup(1440,desktop.token);
  await pc.page.locator('#drawerAvatar').click();await pc.page.locator('#adminSettingsButton').click();
  await pc.page.locator('#createAdminPairingButton').click();
  await pc.page.locator('#adminPairingResult code').waitFor();
  const code=await pc.page.locator('#adminPairingResult code').innerText();
  if(out)await pc.page.screenshot({path:path.join(out,'admin-account-desktop.png')});
  const ordinary=auth.createInvite({label:'phone ordinary'});
  const phoneLogin=auth.activate({inviteCode:ordinary.code,deviceId:'22222222-2222-4222-8222-222222222222'});
  const mobile=await setup(390,phoneLogin.token);
  await mobile.page.evaluate(()=>localStorage.setItem('witt_web_device_id','22222222-2222-4222-8222-222222222222'));
  assert.equal(await mobile.page.locator('#adminSettingsButton').isHidden(),true);
  await mobile.page.locator('#menuButton').click();await mobile.page.locator('#drawerAvatar').click();await mobile.page.locator('#switchAccountButton').click();
  await mobile.page.locator('#cancelAccountSwitch').click();await mobile.page.locator('#authGate').waitFor({state:'hidden'});
  await mobile.page.evaluate(()=>document.querySelector('#switchAccountButton').click());
  await mobile.page.locator('#inviteCode').fill(code);
  await Promise.all([mobile.page.waitForEvent('load'),mobile.page.locator('#activateInviteButton').click()]);
  await mobile.page.waitForTimeout(600);
  assert.equal(await mobile.page.locator('#adminSettingsButton').getAttribute('hidden'),null);
  const token=(await mobile.context.cookies('https://chloe.test/vault-api/')).find(c=>c.name==='witt_session').value;
  assert.equal(auth.authenticateToken(token).userId,auth.authenticateToken(desktop.token).userId);
  assert.equal(auth.authenticateToken(token).admin,true);
  assert.equal(auth.authenticateToken(phoneLogin.token),null);
  assert.deepEqual(pc.errors,[]);assert.deepEqual(mobile.errors,[]);
  if(out)await mobile.page.screenshot({path:path.join(out,'paired-admin-mobile.png')});
  await mobile.page.locator('#menuButton').click();await mobile.page.locator('#drawerAvatar').click();await mobile.page.locator('#adminSettingsButton').click();
  await mobile.page.locator('#createAdminPairingButton').click();await mobile.page.locator('#adminPairingResult code').waitFor();
  if(out)await mobile.page.screenshot({path:path.join(out,'admin-account-mobile.png')});
  console.log('PASS: real AuthService + SQLite + browser HttpOnly cookie; desktop generates code, ordinary mobile switches to SAME admin identity; old mobile token revoked. Other APIs mocked.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(dir,{recursive:true,force:true}));
