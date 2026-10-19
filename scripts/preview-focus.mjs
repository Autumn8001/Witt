// Explicitly local fixture preview. Production code never imports these fixtures.
import {startWorkspaceFixture} from '../tests/support/workspace-fixture.mjs';
import {focusHistory} from '../tests/support/focus-fixtures.mjs';
const fixture=await startWorkspaceFixture({port:4341});
await fetch(new URL('/__test/seed',fixture.url),{method:'POST',body:JSON.stringify(focusHistory)});
console.log(`Chloe Focus: ${fixture.url}\nLOCAL TEST DATA ONLY; real frontend, no production API or model connections.`);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await fixture.close();process.exit(0)});
