// Offline API fixture with actual served GLBs. Start Vite first.
// node frontend/src/minihome/__tests__/layout.browser.mjs [loopbackUrl] [screenshotDir]
import { chromium } from 'playwright';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const WEB = process.argv[2] ?? 'http://127.0.0.1:5183';
const SHOTS = process.argv[3] ?? '.data/layout-browser';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(WEB).hostname)) throw Error('This API fixture requires a loopback web server.');
const browser = await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-webgpu']});
const context = await browser.newContext({viewport:{width:1440,height:1000}});
const page = await context.newPage();
const problems = [], saves = [];
page.on('response', response=>{if(response.status()>=400)console.log('http',response.status(),response.url());});
const user = {id:'1',username:'layout_tester',displayName:'배치 검증',role:'user',permissions:[]};
const profile = {ownerId:'1',username:user.username,ownerName:user.displayName,title:'배치 검증의 섬',statusMessage:'',mood:0,minime:'man',emoji:'🌳',visibility:'public',updatedAt:new Date().toISOString()};
const view = {profile,visits:{today:1,total:1},isOwner:true};
let saved = null;
await page.routeWebSocket(/\/api\/rooms\//, socket=>{socket.onMessage(()=>{});});
// Freeze the loaded UI while other agents edit shared files; Vite HMR is unrelated to the user flow.
await page.routeWebSocket(/[?]token=/, socket=>{socket.onMessage(()=>{});});
page.on('pageerror',error=>{problems.push(error.message);console.log('pageerror',error.message);});
page.on('console',message=>{if(message.type()==='error')problems.push(message.text().slice(0,180));});
await page.route('**/api/**',async route=>{
  const request=route.request(), url=new URL(request.url()), path=url.pathname;
  if(!path.startsWith('/api/'))return route.continue();
  let answer,status=200;
  if(path==='/api/auth/me')answer={user};
  else if(path==='/api/homes/me/world' || path==='/api/homes/layout_tester/world') {
    if(request.method()==='PUT') { const body=request.postDataJSON(); saves.push(body); saved={worldId:body.worldId,revision:saves.length,data:body.data,updatedAt:new Date().toISOString()}; answer=saved; }
    else { answer=saved; if(!saved)status=204; }
  }
  else if(path==='/api/homes/me')answer=view;
  else if(path.includes('/visits'))answer=view.visits;
  else if(path.startsWith('/api/catalog/items'))answer={items:[]};
  else if(path==='/api/looks/me')answer={look:null};
  else if(path==='/api/auth/realtime-ticket')answer={user,ticket:'fixture-local',expiresAt:Date.now()+60000};
  else if(path==='/api/ilchon-requests')answer={received:[],sent:[]};
  else if(path.includes('/ilchons'))answer={ilchons:[],relation:'self',ilchon:null,request:null};
  else if(path.includes('/guestbook'))answer={entries:[],total:0,nextBefore:null};
  else {status=404;answer={error:{code:'not_found',message:path}};}
  await route.fulfill({status,contentType:'application/json',body:status===204?'':JSON.stringify(answer)});
});
try {
await page.goto(WEB + '/@layout_tester/edit');
await page.getByRole('button',{name:'매장 배치',exact:true}).waitFor({timeout:120000});
await page.waitForFunction(()=>!document.querySelector('.mg-world-loading'),null,{timeout:120000});
await page.getByRole('button',{name:'매장 배치',exact:true}).click();
const dialog=page.getByRole('dialog',{name:'매장 배치'});
await dialog.getByRole('button',{name:'배치 만들기'}).click();
await dialog.getByRole('button',{name:'섬에 적용'}).waitFor({timeout:120000});
if(saves.length)throw Error('Preview wrote to world storage');
await page.waitForTimeout(1500);
await mkdir(SHOTS,{recursive:true});
const frame = await dialog.boundingBox();
if (!frame || frame.y < 0 || frame.y + frame.height > 1000) throw Error('The layout dialog is outside the viewport');
await page.screenshot({path:join(SHOTS, 'preview.png')});
const displayed=await dialog.locator('.mg-layout-result').innerText();
const canvas=await dialog.locator('canvas').count();
if(canvas!==1)throw Error('No independent preview canvas');
await dialog.getByRole('button',{name:'섬에 적용'}).click();
await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
await page.getByRole('button',{name:'저장',exact:true}).click();
await page.waitForTimeout(800);
if(saves.length<1)throw Error('No save after apply');
const placed=saves.at(-1).data.domains.building;
const added=placed.objects.filter(v=>v.id.startsWith('obj-'));
if(added.filter(v=>v.config.modelId==='chair-basic').length!==2)throw Error('Chair count mismatch');
await page.getByRole('button',{name:'되돌리기',exact:true}).click();
await page.getByRole('button',{name:'저장',exact:true}).click();
await page.waitForTimeout(800);
const undone=saves.at(-1).data.domains.building;
if(undone.objects.some(v=>added.some(a=>a.id===v.id)))throw Error('Undo kept generated objects');
if(undone.wallGroups.some(v=>v.name==='카페'&&v.walls.length))throw Error('Undo kept generated walls');
await page.getByRole('button',{name:'다시 하기',exact:true}).click();
await page.getByRole('button',{name:'저장',exact:true}).click();
await page.waitForTimeout(800);
if(saves.at(-1).data.domains.building.objects.length!==placed.objects.length)throw Error('Redo object count changed');
await page.screenshot({path:join(SHOTS, 'applied.png')});
const result={displayed,previewCanvas:canvas,saveRequests:saves.length,added:added.map(v=>({id:v.config.modelId,x:v.position.x,z:v.position.z})),problems};
await writeFile(join(SHOTS, 'result.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
if(problems.length)process.exitCode=1;
} finally { await browser.close(); }
