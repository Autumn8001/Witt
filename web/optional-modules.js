(() => {
  'use strict';
  const pending = new Map();
  function script(source) {
    return new Promise((resolve,reject) => {
      const node=document.createElement('script');node.src=source;node.onload=resolve;node.onerror=()=>{node.remove();reject(new Error('Module unavailable'));};document.head.append(node);
    });
  }
  function style(source) {
    return new Promise((resolve,reject) => {
      const node=document.createElement('link');node.rel='stylesheet';node.href=source;node.onload=resolve;node.onerror=()=>{node.remove();reject(new Error('Style unavailable'));};document.head.append(node);
    });
  }
  function load(key, factory) {
    if (!pending.has(key)) pending.set(key, factory().catch(error=>{pending.delete(key);throw error;}));
    return pending.get(key);
  }
  window.WittModules = {
    math: () => load('math',()=>Promise.all([style('/vault/vendor/katex/katex.min.css?v=0.16.22'),script('/vault/vendor/katex/katex.min.js?v=0.16.22')])),
    terminal: () => load('terminal',async()=>{
      await Promise.all([style('/vault/vendor/xterm/xterm.css?v=6.0.0'),script('/vault/vendor/xterm/xterm.js?v=6.0.0')]);
      await Promise.all([script('/vault/vendor/xterm/addon-fit.js?v=0.11.0'),script('/vault/vendor/xterm/addon-web-links.js?v=0.12.0')]);
    }),
  };
})();
