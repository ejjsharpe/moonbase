const original=globalThis.fetch;
globalThis.fetch=(url,options)=>{
  if(new URL(typeof url==='string'?url:url.url??String(url)).hostname!=='127.0.0.1')throw Error('Provider network is disabled in this controlled child.');
  return original(url,options);
};
