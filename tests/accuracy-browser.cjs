const { chromium }=require('playwright');
const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');const results=path.join(root,'review');fs.mkdirSync(results,{recursive:true});
(async()=>{
 const server=http.createServer((req,res)=>{const name=req.url.split('?')[0]==='/'?'index.html':req.url.split('?')[0].slice(1); if(!['index.html','insights.js','insights.css','visual.css','analytics-config.js','orvantro-analytics.js'].includes(name)){res.writeHead(404);return res.end();}res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,name)));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 let browser;
 const launchOptions={headless:true,chromiumSandbox:true};
 if(process.env.CHROMIUM_EXECUTABLE_PATH) launchOptions.executablePath=process.env.CHROMIUM_EXECUTABLE_PATH;
 try{browser=await chromium.launch(launchOptions);
 const page=await browser.newPage({viewport:{width:1365,height:1000}});const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{if(!r.request().url().startsWith(base)){external.push(r.request().url());return r.abort();}return r.continue();});
 await page.goto(base);await page.waitForFunction(()=>document.querySelector('#statusLine').textContent.includes('로컬 기록이 없습니다'));
 await page.click('#btnUseSample');
 const chart=await page.locator('#trendChart').evaluate(c=>({width:c.width,height:c.height,hidden:document.querySelector('#trendEmpty').hidden}));
 assert.ok(chart.width>0&&chart.height>0);assert.equal(chart.hidden,true);
 assert.equal(await page.locator('#trendEmpty').isVisible(),false);
 await page.screenshot({path:path.join(results,'00-sample-trend.png'),fullPage:true});
 await page.selectOption('#filterCountry','JP');await page.click('#local-settings summary');await page.click('#btnEnableLocal');await page.waitForFunction(()=>document.querySelector('#kpiPageviews').textContent==='1');assert.equal(await page.inputValue('#filterCountry'),'all');
 for(let i=0;i<2;i++){await page.click('#btnUseSample');await page.selectOption('#filterCountry','JP');await page.click('#btnLive');await page.waitForFunction(()=>document.querySelector('#kpiPageviews').textContent==='1');assert.equal(await page.inputValue('#filterCountry'),'all');}
 await page.screenshot({path:path.join(results,'01-local-after-sample.png'),fullPage:true});console.log('PASS sample → country JP → local data, repeated twice; 1 local PV retained');
 const row=(x)=>({t:Date.now()-1000,type:'pageview',site:'orvantro',...x});
 await page.fill('#importJson',JSON.stringify([row({visitor_id:'unknown',engaged_ms:0}),row({visitor_id:'known',returning:true,engaged_ms:10000}),row({visitor_id:'missing'})]));await page.click('#btnImport');await page.waitForFunction(()=>document.querySelector('#kpiPageviews').textContent==='3');
 assert.equal(await page.textContent('#kpiEngage'),'5s');assert.equal(await page.textContent('#kpiReturning'),'100%');assert.match(await page.textContent('#kpiReturningHint'),/미상 2명/);assert.match(await page.textContent('#statusLine'),/가져온 JSON만/);
 await page.screenshot({path:path.join(results,'02-import-unknown-zero.png'),fullPage:true});console.log('PASS import: 0s+10s+missing =>5s; 2 unknown omitted from return rate denominator');
 await page.fill('#importJson',JSON.stringify([row({visitor_id:'unknown',engaged_ms:0})]));await page.click('#btnImport');await page.waitForFunction(()=>document.querySelector('#kpiEngage').textContent==='0s');assert.equal(await page.textContent('#kpiReturning'),'미수집');
 await page.click('#btnClearImport');await page.waitForFunction(()=>document.querySelector('#kpiPageviews').textContent==='1');await page.reload();await page.waitForFunction(()=>document.querySelector('#kpiPageviews').textContent==='2');console.log('PASS zero-only renders 0s; import clear/reload preserve local-only data');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(results,'03-mobile-local.png'),fullPage:true});
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log('PASS no page errors or external network requests');
 }finally{if(browser) await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
