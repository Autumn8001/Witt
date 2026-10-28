
(() => {
  const root=document.querySelector('#bootScreen .boot-stage'); if (!root) return; const word=root.querySelector('#wittLaunch-word');
  const ink=[...root.querySelectorAll('.ink')],light=[...root.querySelectorAll('.light')];
  const paths=['w','i','t1','t2'].map(id=>root.querySelector('#wittLaunch-'+id));
  const lengths=paths.map(p=>p.getTotalLength());
  const starts=[160,870,1130,1430],durations=[900,380,440,440];
  const pen=root.querySelector('#wittLaunch-pen'),halo=root.querySelector('.halo');
  const finish=root.querySelector('.finish'),sheen=root.querySelector('#wittLaunch-sheen');
  const shadow=root.querySelector('.shadow'),sparkGroup=root.querySelector('#wittLaunch-sparks');
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  const sparks=Array.from({length:7},()=>{const el=document.createElementNS('http://www.w3.org/2000/svg','circle');el.setAttribute('class','spark');el.setAttribute('r','1.2');sparkGroup.appendChild(el);return el;});
  let start=0,frame=0,history=[];
  const clamp=n=>Math.max(0,Math.min(1,n));
  const ease=n=>n*n*(3-2*n);
  function still(){
    cancelAnimationFrame(frame);word.setAttribute('transform','');word.setAttribute('opacity','1');
    ink.forEach(p=>p.style.strokeDashoffset='0');light.forEach(p=>p.style.opacity='0');
    pen.setAttribute('opacity','0');finish.style.opacity='0';halo.style.opacity='0';shadow.style.opacity='0';sparks.forEach(s=>s.setAttribute('opacity','0'));
  }
  function draw(now){
    if(document.hidden || !root.isConnected || root.closest('#bootScreen').style.visibility==='hidden' || root.closest('#bootScreen').classList.contains('leaving'))return;
    if(!start)start=now;
    let time=now-start;
    time=Math.min(time,2850);
    const exit=ease(clamp((time-2850)/650));
    const entrance=ease(clamp(time/850));
    const scale=.96+.04*entrance+.035*exit;
    word.setAttribute('transform',`translate(140 75) scale(${scale}) translate(-140 ${-75+5*(1-entrance)-4*exit})`);
    word.setAttribute('opacity',String(1-exit));
    let point=null;
    for(let i=0;i<4;i++){
      const progress=ease(clamp((time-starts[i])/durations[i]));
      ink[i].style.strokeDashoffset=String(1-progress);
      light[i].style.strokeDashoffset=String(1-progress);
      light[i].style.opacity=String(.75*(1-ease(clamp((time-1850)/450))));
      if(progress>0&&progress<1)point=paths[i].getPointAtLength(lengths[i]*progress);
    }
    if(point){
      pen.setAttribute('transform',`translate(${point.x} ${point.y})`);pen.setAttribute('opacity','1');
      history.unshift({x:point.x,y:point.y,time});
    }else pen.setAttribute('opacity','0');
    history=history.filter(p=>time-p.time<220).slice(0,45);
    sparks.forEach((s,i)=>{
      const p=history[i*4];
      if(!p){s.setAttribute('opacity','0');return;}
      const age=(time-p.time)/220;
      s.setAttribute('cx',String(p.x));s.setAttribute('cy',String(p.y+age*4));s.setAttribute('opacity',String((1-age)*.4*(1-exit)));
    });
    halo.style.opacity=String(Math.sin(clamp(time/3200)*Math.PI)*.8*(1-exit));
    halo.style.transform=`scale(${.8+.3*entrance})`;
    shadow.style.opacity=String(.07*entrance*(1-exit));
    const shine=clamp((time-1900)/800);
    sheen.setAttribute('gradientTransform',`translate(${-80+460*shine} 0)`);
    finish.style.opacity=String(shine>0&&shine<1 ? .75*Math.sin(shine*Math.PI):0);
    frame=requestAnimationFrame(draw);
  }
  function replay(){if(!root.isConnected)return;cancelAnimationFrame(frame);start=0;history=[];if(motion.matches)still();else frame=requestAnimationFrame(draw);}


  document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelAnimationFrame(frame);else if(root.isConnected && !motion.matches)frame=requestAnimationFrame(draw);});
  motion.addEventListener('change',replay);
  replay();
})();
