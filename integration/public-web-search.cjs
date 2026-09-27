'use strict';
const decode=s=>String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
async function search(query,{signal,fetchImpl=fetch}={}){
 if(typeof query!=='string'||!query.trim()||query.length>500)throw Error('搜索词须为 1–500 字');
 const r=await fetchImpl('https://www.bing.com/search?format=rss&q='+encodeURIComponent(query),{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),redirect:'error'});
 if(!r.ok)throw Error('搜索服务 HTTP '+r.status);
 let xml='',bytes=0;for await(const chunk of r.body){bytes+=chunk.length;if(bytes>1024*1024)throw Error('搜索响应过大');xml+=Buffer.from(chunk).toString('utf8')}
 const results=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0,6).map(m=>{const field=n=>decode(m[1].match(new RegExp('<'+n+'>([\\s\\S]*?)</'+n+'>'))?.[1]);return{title:field('title'),url:field('link'),snippet:field('description').slice(0,1600)}}).filter(x=>/^https?:\/\//.test(x.url));
 if(!results.length)throw Error('搜索没有返回有效结果');return{query,retrievedAt:new Date().toISOString(),results};
}
module.exports={search};
