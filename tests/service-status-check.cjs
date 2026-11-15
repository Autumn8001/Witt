const assert=require('node:assert/strict');
const {discoverServiceStatus}=require('../backend/service-status');
(async()=>{
 let added=false;
 const execute=async(command,args)=>{
  assert.equal(command,'systemctl');assert(args.includes('--output=json'));
  return {stdout:JSON.stringify(args[0]==='list-units'?
   [{unit:'drop-vault.service',active:'active',sub:'running',load:'loaded',description:'Witt'},{unit:'failed-example.service',active:'failed',sub:'failed',load:'loaded',description:'Example'},...(added?[{unit:'new-app.service',active:'active',sub:'running',load:'loaded',description:'New app'}]:[])]:
   [{unit_file:'drop-vault.service',state:'enabled'},{unit_file:'future-app.service',state:'disabled'}])};
 };
 let data=await discoverServiceStatus(execute);
 assert.equal(data.serviceCounts.total,3);assert.equal(data.serviceCounts.failed,1);
 assert(data.services.some(s=>s.unit==='future-app.service'&&s.status==='inactive'));
 assert.equal(data.services[0].status,'failed');
 added=true;data=await discoverServiceStatus(execute);assert(data.services.some(s=>s.unit==='new-app.service'));
 const partial=await discoverServiceStatus(async(cmd,args)=>{if(args[0]==='list-unit-files')throw Error('private diagnostic');return execute(cmd,args)});
 assert.equal(partial.serviceDiscovery.complete,false);assert.equal(partial.serviceDiscovery.available,true);assert(!JSON.stringify(partial).includes('private diagnostic'));
 const failed=await discoverServiceStatus(async()=>{throw Error('secret diagnostic')});assert.equal(failed.serviceDiscovery.available,false);assert.equal(failed.services.length,0);
 // Test both status routes at the service boundary, including non-admin scope.
 const overview=require('../backend/workspace-overview');let options;
 overview.workspaceOverview=async input=>{options=input;return {services:[]}};
 const {ChatService}=require('../backend/chat-service');
 const service=Object.create(ChatService.prototype);service.codexWorkDir='/tmp/test-work';service.dataDir='/tmp/test-data';
 for(const route of ['/chat/projects?view=service-status','/chat/workspace-overview']){
  for(const admin of [false,true]){
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('route did not respond')),1000);service.sendJson=(_r,status)=>{try{assert.equal(status,200);assert.equal(options.admin,admin);clearTimeout(timer);resolve()}catch(e){reject(e)}};
    assert.equal(service.handle({method:'GET'},{},new URL(route,'http://test'),{admin}),true);
   });
  }
 }
 console.log('PASS service discovery, new units, partial failure, native compatibility and permission scope');
})().catch(e=>{console.error(e);process.exitCode=1});
