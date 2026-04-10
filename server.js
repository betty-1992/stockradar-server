/**
 * StockRadar Server v2
 * Railway 환경변수:
 *   PORT, FMP_KEY, GEMINI_KEY, ALLOWED_ORIGIN
 */
'use strict';
const http=require('http'),https=require('https'),fs=require('fs'),path=require('path'),url=require('url');
const PORT=process.env.PORT||3001;
const FMP_KEY=process.env.FMP_KEY||'';
const GEMINI_KEY=process.env.GEMINI_KEY||'';
const ALLOWED_ORIGIN=process.env.ALLOWED_ORIGIN||'*';
const CACHE_FILE=path.join(__dirname,'cache.json');
let cache={stocks:[],lastBatch:null};
try{if(fs.existsSync(CACHE_FILE)){cache=JSON.parse(fs.readFileSync(CACHE_FILE,'utf8'));console.log(`캐시: ${cache.stocks?.length}개`);}}catch(e){}
const saveCache=()=>{try{fs.writeFileSync(CACHE_FILE,JSON.stringify(cache));}catch(e){}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function setCors(res,origin){
  const allowed=ALLOWED_ORIGIN==='*'?'*':
    (origin&&(origin===ALLOWED_ORIGIN||origin.endsWith('.vercel.app')||origin.includes('localhost')))?origin:ALLOWED_ORIGIN;
  res.setHeader('Access-Control-Allow-Origin',allowed);
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials','true');
}

function httpGet(u,hdrs={}){return new Promise((res,rej)=>{
  const pu=new URL(u);
  const req=(pu.protocol==='https:'?https:http).request({hostname:pu.hostname,path:pu.pathname+pu.search,method:'GET',headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json',...hdrs},timeout:20000},r=>{
    const ch=[];r.on('data',c=>ch.push(c));r.on('end',()=>{try{res(JSON.parse(Buffer.concat(ch).toString()));}catch(e){rej(new Error('JSON fail'));}});
  });req.on('error',rej);req.on('timeout',()=>{req.destroy();rej(new Error('Timeout'));});req.end();
});}

function httpPost(u,body,hdrs={}){return new Promise((res,rej)=>{
  const pu=new URL(u);const data=JSON.stringify(body);
  const req=https.request({hostname:pu.hostname,path:pu.pathname+pu.search,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),...hdrs},timeout:30000},r=>{
    const ch=[];r.on('data',c=>ch.push(c));r.on('end',()=>{try{res(JSON.parse(Buffer.concat(ch).toString()));}catch(e){rej(new Error('JSON fail'));}});
  });req.on('error',rej);req.on('timeout',()=>{req.destroy();rej(new Error('Timeout'));});req.write(data);req.end();
});}

async function fetchKrx(market='STK'){
  const d=new Date(),day=d.getDay();
  if(day===0)d.setDate(d.getDate()-2);if(day===6)d.setDate(d.getDate()-1);
  const trdDd=`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const body=new URLSearchParams({bld:'dbms/MDC/STAT/standard/MDCSTAT01901',mktId:market,trdDd,money:'1',csvxls_isNo:'false'}).toString();
  try{
    const data=await new Promise((res,rej)=>{
      const req=https.request({hostname:'www.krx.co.kr',path:'/comm/bldAttendant/getJsonData.cmd',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body),'Referer':'https://www.krx.co.kr/','User-Agent':'Mozilla/5.0'},timeout:15000},r=>{
        const ch=[];r.on('data',c=>ch.push(c));r.on('end',()=>{try{res(JSON.parse(Buffer.concat(ch).toString()));}catch(e){rej(e);}});
      });req.on('error',rej);req.on('timeout',()=>{req.destroy();rej(new Error('KRX timeout'));});req.write(body);req.end();
    });
    const rows=data?.OutBlock_1||data?.output||[];
    if(!rows.length)throw new Error('빈 응답');
    const list=rows.map(r=>({id:(r.ISU_SRT_CD||r.종목코드||'').trim(),nm:(r.ISU_ABBRV||r.종목명||'').trim(),market:market==='STK'?'KOSPI':'KOSDAQ'})).filter(s=>/^\d{6}$/.test(s.id));
    console.log(`KRX ${market}: ${list.length}개`);return list;
  }catch(e){
    console.warn(`KRX ${market} 실패(${e.message}), 폴백`);
    return FALLBACK.filter(id=>market==='KSQ'?KOSDAQ_SET.has(id):!KOSDAQ_SET.has(id)).map(id=>({id,nm:'',market:market==='STK'?'KOSPI':'KOSDAQ'}));
  }
}

async function fetchPrices(ids,isKr=false){
  const res={};const syms=isKr?ids.map(id=>`${id}.KS`):ids;
  for(let i=0;i<syms.length;i+=30){
    const chunk=syms.slice(i,i+30).join(',');
    try{
      const d=await httpGet(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(chunk)}`);
      (d?.quoteResponse?.result||[]).forEach(q=>{
        const id=q.symbol.replace(/\.(KS|KQ)$/,'');const px=q.regularMarketPrice||0;if(!px)return;
        res[id]={price:px,change:q.regularMarketChange||0,changeRate:q.regularMarketChangePercent||0,volume:q.regularMarketVolume||0,
          high52:q.fiftyTwoWeekHigh||0,low52:q.fiftyTwoWeekLow||0,
          drop:q.fiftyTwoWeekHigh>0?Math.max(0,Math.round(((px-q.fiftyTwoWeekHigh)/q.fiftyTwoWeekHigh)*-100)):0,
          pe:q.trailingPE||0,div:q.trailingAnnualDividendYield?+(q.trailingAnnualDividendYield*100).toFixed(2):0,
          mc:q.marketCap?Math.round(q.marketCap/1e6):0,name:q.shortName||q.longName||id,currency:isKr?'KRW':'USD'};
      });
    }catch(e){console.warn(`Yahoo ${i}: ${e.message}`);}
    if(i+30<syms.length)await sleep(150);
  }return res;
}

async function fmpScreener(key){
  let all=[];
  for(const ex of['NASDAQ','NYSE','AMEX']){
    try{const d=await httpGet(`https://financialmodelingprep.com/api/v3/stock-screener?marketCapMoreThan=300000000&exchange=${ex}&limit=300&apikey=${key}`);
      if(d?.['Error Message']){console.warn('FMP:',d['Error Message']);break;}
      if(Array.isArray(d)){all=all.concat(d);console.log(`FMP ${ex}: ${d.length}개`);}
    }catch(e){console.warn(`FMP ${ex}: ${e.message}`);}
    await sleep(300);
  }
  const seen=new Set();
  return all.filter(s=>{if(seen.has(s.symbol))return false;seen.add(s.symbol);return true;}).sort((a,b)=>(b.marketCap||0)-(a.marketCap||0)).slice(0,500);
}

async function fmpFundamentals(syms,key){
  const res={};const list=syms.slice(0,200);
  for(let i=0;i<list.length;i++){
    const sym=list[i];
    try{const km=await httpGet(`https://financialmodelingprep.com/api/v3/key-metrics-ttm/${sym}?apikey=${key}`);
      if(Array.isArray(km)&&km[0])res[sym]={roe:km[0].roe?+(km[0].roe*100).toFixed(1):0,fcf:km[0].freeCashFlowYield?+(km[0].freeCashFlowYield*100).toFixed(1):0,peg:km[0].pegRatio?+km[0].pegRatio.toFixed(2):0,roic:km[0].roic?+(km[0].roic*100).toFixed(1):0};
    }catch(_){}
    if(i%5===0){try{const gr=await httpGet(`https://financialmodelingprep.com/api/v3/income-statement-growth/${sym}?limit=1&apikey=${key}`);
      if(Array.isArray(gr)&&gr[0]){res[sym]=res[sym]||{};res[sym].rev=gr[0].growthRevenue?+(gr[0].growthRevenue*100).toFixed(1):0;}}catch(_){}await sleep(400);}
    if(i%25===0)console.log(`재무지표 ${i}/${list.length}`);
  }return res;
}

async function callGemini(prompt){
  if(!GEMINI_KEY)throw new Error('GEMINI_KEY 환경변수 없음');
  const data=await httpPost('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
    {contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:.7,maxOutputTokens:600}},
    {'x-goog-api-key':GEMINI_KEY});
  if(data.error)throw new Error(data.error.message);
  return data.candidates?.[0]?.content?.parts?.[0]?.text||'분석 결과 없음';
}

let batchRunning=false,batchProg={pct:0,msg:'',log:[]};
async function runBatch(key){
  const p=(pct,msg)=>{batchProg={pct,msg,log:[...batchProg.log,`[${pct}%] ${msg}`].slice(-60)};console.log(`[${pct}%] ${msg}`);};
  const all={};
  p(3,'KRX 코스피...');const kospi=await fetchKrx('STK');
  p(8,'KRX 코스닥...');const kosdaq=await fetchKrx('KSQ');
  const krList=[...kospi,...kosdaq];p(12,`한국 ${krList.length}개`);
  p(14,`Yahoo 한국 ${krList.length}개...`);
  const krP=await fetchPrices(krList.map(s=>s.id),true);p(30,`한국 시세 ${Object.keys(krP).length}개`);
  krList.forEach(s=>{const q=krP[s.id];if(!q?.price)return;all[s.id]={nm:q.name||s.nm||s.id,sec:KR_SEC[s.id]||(s.market==='KOSDAQ'?'KOSDAQ':'KOSPI'),tags:krTags(s.id,s.market),market:s.market,geo:false,inst:false,mc:q.mc||0,per:q.pe||0,div:q.div||0,drop:q.drop||0,roe:0,rev:0,fcf:0,peg:0,roic:0,price:q.price,changeRate:q.changeRate,high52:q.high52,low52:q.low52,currency:'KRW',_src:'krx'};});
  p(32,`한국 확정 ${Object.keys(all).length}개`);
  p(34,'FMP 미국...');const usRaw=await fmpScreener(key);p(50,`미국 ${usRaw.length}개`);
  usRaw.forEach(s=>{all[s.symbol]={nm:s.companyName||s.symbol,sec:mapSec(s.sector),tags:usTags(s.symbol,s.sector,s.industry),market:s.exchangeShortName||'US',geo:false,inst:true,mc:s.marketCap?Math.round(s.marketCap/1e6):0,per:s.pe||0,div:s.lastAnnualDividend||0,drop:0,roe:0,rev:0,fcf:0,peg:0,roic:0,currency:'USD',_src:'fmp'};});
  const usIds=Object.keys(all).filter(id=>!/^\d{6}$/.test(id));
  p(52,`Yahoo 미국 ${usIds.length}개...`);
  const usP=await fetchPrices(usIds,false);
  Object.entries(usP).forEach(([id,q])=>{if(!all[id])return;Object.assign(all[id],{price:q.price,changeRate:q.changeRate,high52:q.high52,low52:q.low52,drop:q.drop||all[id].drop,per:q.pe||all[id].per,div:q.div||all[id].div,mc:q.mc||all[id].mc});});
  p(68,'재무지표...');
  const topUs=usIds.sort((a,b)=>(all[b]?.mc||0)-(all[a]?.mc||0)).slice(0,200);
  const fund=await fmpFundamentals(topUs,key);
  Object.entries(fund).forEach(([id,f])=>{if(!all[id])return;if(f.roe)all[id].roe=f.roe;if(f.rev)all[id].rev=f.rev;if(f.fcf)all[id].fcf=f.fcf;if(f.peg)all[id].peg=f.peg;if(f.roic)all[id].roic=f.roic;});
  const list=Object.entries(all).map(([id,s])=>({id,...s})).filter(s=>s.nm&&s.price>0);
  cache.stocks=list;cache.lastBatch=Date.now();saveCache();
  p(100,`완료! 총 ${list.length}개`);return list;
}

const mapSec=s=>({'Technology':'Technology','Information Technology':'Technology','Healthcare':'Healthcare','Health Care':'Healthcare','Financials':'Financials','Financial Services':'Financials','Consumer Discretionary':'Consumer','Consumer Staples':'Consumer','Communication Services':'Communication','Energy':'Energy','Industrials':'Industrials','Materials':'Materials','Utilities':'Utilities','Real Estate':'Real Estate'})[s]||s||'Other';
const CEASE_KR=['003490','028050','011200','298040','034020','012450','000720','028670','010950','042660'];
const CEASE_US=['XOM','CVX','COP','OXY','SLB','HAL','PSX','MPC','DAL','UAL','AAL','RCL','BKNG','MAR','LMT','RTX','GD','NOC'];
const KR_SEC={'005930':'Technology','000660':'Technology','207940':'Healthcare','005380':'Consumer','000270':'Consumer','035420':'Technology','105560':'Financials','055550':'Financials','086790':'Financials','051910':'Materials','006400':'Technology','028260':'Consumer','068270':'Healthcare','009150':'Technology','035720':'Technology','066570':'Technology','373220':'Industrials','005490':'Materials','032830':'Financials','138040':'Financials','316140':'Financials','003490':'Industrials','028050':'Industrials','012450':'Industrials','011200':'Industrials','034020':'Industrials','298040':'Industrials','042660':'Industrials','010950':'Energy','000720':'Industrials'};
const KOSDAQ_SET=new Set(['247540','095570','122870','352820','263750','259960','112040','357780','196170','131760','214450','086280','185750','041510','091990','293490','302440','145020','326030','251270']);
const FALLBACK=['005930','000660','207940','005380','000270','035420','105560','055550','086790','051910','006400','028260','068270','009150','035720','066570','373220','005490','032830','138040','316140','003490','028050','012450','011200','298040','042660','010950','000720','028670','030200','017670','033780','000100','023530','069960','004370','004020','006360','011780','000390','047050','006280','034730','003550','082740','024110','047810','010620','007070','018880','247540','095570','122870','352820','263750','259960','112040','357780','196170','131760','214450','041510','091990','293490','302440'];
const krTags=(id,market)=>{const t=[market||'KOSPI'];const s=KR_SEC[id];if(s&&!['KOSPI','KOSDAQ'].includes(s))t.push(s);if(CEASE_KR.includes(id))t.push('종전수혜');return t.slice(0,3);};
const usTags=(sym,sec,ind)=>{const i=(ind||'').toLowerCase(),t=[];if(i.includes('semiconductor'))t.push('반도체');if(i.includes('software')||i.includes('saas'))t.push('SaaS');if(i.includes('cloud'))t.push('클라우드');if(i.includes('artificial intel')||i.includes('machine learn'))t.push('AI');if(i.includes('oil')||i.includes('gas'))t.push('에너지');if(i.includes('airline'))t.push('항공');if(i.includes('bank'))t.push('금융');if(i.includes('biotech')||i.includes('drug'))t.push('바이오');if(CEASE_US.includes(sym))t.push('종전수혜');return t.slice(0,3);};

const server=http.createServer(async(req,res)=>{
  const origin=req.headers.origin||'';
  setCors(res,origin);
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  const{pathname,query}=url.parse(req.url,true);

  if(pathname==='/'||pathname==='/index.html'){
    const f=path.join(__dirname,'StockRadar.html');
    res.setHeader('Content-Type','text/html;charset=utf-8');
    res.writeHead(fs.existsSync(f)?200:404);
    res.end(fs.existsSync(f)?fs.readFileSync(f):'<h2>StockRadar.html 없음</h2>');return;
  }

  res.setHeader('Content-Type','application/json;charset=utf-8');

  if(pathname==='/api/status'){res.writeHead(200);res.end(JSON.stringify({ok:true,stocks:cache.stocks?.length||0,lastBatch:cache.lastBatch,batchRunning,fmpKeySet:!!FMP_KEY,geminiKeySet:!!GEMINI_KEY}));return;}
  if(pathname==='/api/stocks'){res.writeHead(200);res.end(JSON.stringify({ok:true,count:cache.stocks?.length||0,stocks:cache.stocks||[],lastBatch:cache.lastBatch}));return;}

  if(pathname==='/api/prices'){
    const syms=(query.symbols||'').split(',').filter(Boolean).slice(0,200);
    if(!syms.length){res.writeHead(400);res.end(JSON.stringify({error:'symbols 필요'}));return;}
    const kr=syms.filter(s=>/^\d{6}$/.test(s)),us=syms.filter(s=>!/^\d{6}$/.test(s));
    const prices={};
    if(kr.length)Object.assign(prices,await fetchPrices(kr,true));
    if(us.length)Object.assign(prices,await fetchPrices(us,false));
    res.writeHead(200);res.end(JSON.stringify({ok:true,count:Object.keys(prices).length,prices}));return;
  }

  // AI 분석 — 서버에서 Gemini 키 관리
  if(pathname==='/api/ai'){
    if(!GEMINI_KEY){res.writeHead(503);res.end(JSON.stringify({error:'GEMINI_KEY 환경변수 설정 필요'}));return;}
    let body='';
    req.on('data',chunk=>{body+=chunk;if(body.length>10000)req.destroy();});
    await new Promise(r=>req.on('end',r));
    try{
      const{prompt}=JSON.parse(body);
      if(!prompt){res.writeHead(400);res.end(JSON.stringify({error:'prompt 필요'}));return;}
      const result=await callGemini(prompt);
      res.writeHead(200);res.end(JSON.stringify({ok:true,result}));
    }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    return;
  }

  if(pathname==='/api/batch'){
    const key=FMP_KEY;
    if(!key){res.writeHead(400);res.end(JSON.stringify({error:'FMP_KEY 환경변수 설정 필요'}));return;}
    if(batchRunning){res.writeHead(409);res.end(JSON.stringify({error:'배치 이미 실행 중'}));return;}
    batchRunning=true;batchProg={pct:0,msg:'시작',log:[]};
    runBatch(key).then(list=>{batchRunning=false;console.log(`완료: ${list.length}개`);}).catch(e=>{batchRunning=false;batchProg.msg=`오류: ${e.message}`;console.error(e.message);});
    res.writeHead(200);res.end(JSON.stringify({ok:true,message:'배치 시작. /api/batch/status 확인'}));return;
  }

  if(pathname==='/api/batch/status'){res.writeHead(200);res.end(JSON.stringify({running:batchRunning,...batchProg,stocks:cache.stocks?.length||0,lastBatch:cache.lastBatch}));return;}

  if(pathname==='/api/krx'){
    try{const list=await fetchKrx(query.market||'STK');res.writeHead(200);res.end(JSON.stringify({ok:true,count:list.length,stocks:list}));}
    catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}return;
  }

  res.writeHead(404);res.end(JSON.stringify({error:'Not Found',routes:['GET /','GET /api/status','GET /api/stocks','GET /api/prices?symbols=','POST /api/ai','POST /api/batch','GET /api/batch/status','GET /api/krx?market=']}));
});

server.listen(PORT,()=>{
  console.log(`\nStockRadar Server v2 → http://localhost:${PORT}`);
  console.log(`FMP: ${FMP_KEY?'✅':'❌'}  Gemini: ${GEMINI_KEY?'✅':'❌'}  Origin: ${ALLOWED_ORIGIN}\n`);
});
