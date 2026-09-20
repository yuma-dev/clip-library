import {useLayoutEffect, useRef, type CSSProperties, type ReactElement} from 'react';
import type {ExportSpec} from './types';
import ClipGroup from '../library/ClipGroup';
import ExportProgress from '../player/ExportProgress';
import Sidebar from '../shell/Sidebar';
import Titlebar from '../shell/Titlebar';
import {ToastProvider} from '../ui/Toast';
import type {UseLibraryFilter} from '../library/useLibraryFilter';
import logo from '../../../assets/title.png';
import overlaySource from '../../../clipdip/overlay.html?raw';
import overlayLogo from '../../../clipdip/assets/logo250x250.png';

const clamp=(x:number)=>Math.max(0,Math.min(1,x));
const ease=(t:number,a:number,b:number)=>{const x=clamp((t-a)/(b-a));return x*x*(3-2*x);};
// CSS cubic-bezier(.42, 0, .58, 1), solved by x so seeking is deterministic.
const cameraEase=(t:number,a:number,b:number)=>{
  const x=clamp((t-a)/(b-a));
  if(x===0||x===1)return x;
  let lo=0,hi=1,u=x;
  for(let i=0;i<24;i++){
    u=(lo+hi)/2;
    const bx=3*(1-u)*(1-u)*u*.42+3*(1-u)*u*u*.58+u*u*u;
    if(bx<x)lo=u;else hi=u;
  }
  return 3*(1-u)*u*u+u*u*u;
};
const noop=()=>{};
const overlayDocument=overlaySource.replace(/<script>[\s\S]*?<\/script>/g,'').replace('/logo250x250.png',overlayLogo).replace('</head>','<style>:root{color-scheme:dark}html,body{background:transparent!important}input{caret-color:transparent}</style></head>');

/** Read-only, seekable demo using production shell/cards, boot CSS and overlay HTML.
 * Native splash geometry is adapted from crates/launcher; operations are staged. */
export function HeroScene({spec,Player}:{spec:ExportSpec;Player:(s:ExportSpec)=>ReactElement}){
  const t=Number(spec.props?.time??0),frame=useRef<HTMLIFrameElement>(null);
  const start=2.6,opened=t>=19.4,arrived=t>=17.4;
  const shown=arrived?[{...spec.fixtures[0].clip,customName:'Clean Finish',createdAt:Date.UTC(2026,8,18),isNewSinceLastSession:true},...spec.fixtures.slice(1).map(f=>f.clip)]:spec.fixtures.slice(1).map(f=>f.clip);
  const globalTags=['Epic','Favorite','League of Legends','Overwatch'];
  const tags={saved:new Set([...globalTags,'Untagged','Unnamed']),temporary:new Set<string>(),isTemporary:false};
  const filter:UseLibraryFilter={query:'',setQuery:noop,collection:'all',setCollection:noop,allTags:[...tags.saved],globalTags,tags,selectedCount:6,totalCount:6,toggleTag:noop,focusTag:noop,showAllTags:noop,hideAllTags:noop,clearFocus:noop,addGlobalTag:noop,renameGlobalTag:noop,removeGlobalTag:noop,filteredClips:shown};
  // Interpolate screen-space translation and scale together: no multiplied pan arc.
  const notification= cameraEase(t,6.5,9)*(1-cameraEase(t,15.6,17.1));
  const exporting=cameraEase(t,26.3,26.9);
  const z=1+notification*2.5+exporting*1.6;
  const tx=notification*(-4310)+exporting*(-2770);
  const ty=notification*107.5+exporting*48;
  const scroll=0;
  const splashOpacity=ease(t,.2,.46)*(1-ease(t,2.55,2.67));
  const phase=t<9.4?'saving':t<14.8?'saved':'renamed';
  const draft='Clean Finish'.slice(0,Math.floor(clamp((t-12)/2.15)*12));
  const videoTime=t<21?28:t<23?14*ease(t,21,23):t<24?14:t<26?58.166667-12.166667*ease(t,24,26):46;
  const playerSpec:ExportSpec={...spec,props:{rootId:'hero-player',width:1440,pad:0,cameraX:-80,cameraY:-40,navigation:true,title:'Clean Finish',durationSeconds:58.166667,currentSeconds:videoTime,mediaTime:videoTime,trimStart:14*ease(t,21,23),trimEnd:58.166667-12.166667*ease(t,24,26),controlsShade:.92,frameWidth:1600,frameHeight:900}};
  const end=ease(t,31,32);

  useLayoutEffect(()=>{
    window.__EXPORT_SCENE_SEEK__=async()=>{
      const body=document.querySelector('#hero-window .app-body')!;
      body.classList.add('boot-dolly');
      const rail=body.querySelector<HTMLElement>('.rail');rail?.classList.add('boot-par');rail?.style.setProperty('--boot-d','60ms');
      body.querySelectorAll<HTMLElement>('.clip-item').forEach((el,i)=>{el.classList.add('boot-par');el.style.setProperty('--boot-d',`${100+Math.floor(i/4)*55}ms`);});
      document.getElementById('hero-scroll')!.scrollTop=scroll;
      for(const a of document.getAnimations()){if((a as CSSAnimation).animationName?.startsWith('boot-')){a.pause();a.currentTime=Math.max(0,(t-start)*1000);}}
      const f=frame.current!;
      if(!f.contentDocument?.querySelector('#card'))await new Promise<void>(resolve=>f.addEventListener('load',()=>resolve(),{once:true}));
      const doc=f.contentDocument!;await doc.fonts.ready;
      await Promise.all([...doc.images].map(i=>i.decode().catch(()=>{})));
      const card=doc.getElementById('card')!;
      const classes=`card entered ${phase}${phase==='saved'?' saved-pop flash glow':''}${t>=11.7&&t<14.8?' focused':''}`;
      if(card.className!==classes)card.className=classes;
      doc.querySelector('.anchor')!.className='anchor top_right';
      doc.getElementById('title')!.textContent=phase==='saving'?'Saving clip…':phase==='saved'?'Clip saved':'Renamed!';
      (doc.getElementById('rename-input') as HTMLInputElement).value=draft;
      doc.getElementById('rename-display')!.textContent='Clean Finish';
      doc.querySelector('.sheen')?.classList.toggle('on',phase==='saved');
      const hint=doc.getElementById('hint')!;hint.style.opacity=t>=11.7&&t<14.8?'0':'1';
      const phaseStart=phase==='saving'?7.2:phase==='saved'?9.4:14.8;
      for(const a of doc.getAnimations()){a.pause();a.currentTime=Math.max(0,(t-((a as CSSAnimation).animationName==='luxein'?7.2:phaseStart))*1000);}
      // New-card arrival uses a separate wrapper so it doesn't replace production boot motion.
    };
    return()=>{delete window.__EXPORT_SCENE_SEEK__;};
  });

  return <div id="export-root" style={{position:'relative',width:1600,height:900,overflow:'hidden',background:'#050608'}}>
    <div id="hero-desktop" style={{position:'absolute',inset:0,transformOrigin:'0 0',transform:`translate(${tx}px,${ty}px) scale(${z})`}}>
      <img src={`file://${String(spec.props?.wallpaper)}`} style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover'}}/>
      <div style={{position:'absolute',left:730,top:345,width:140,height:140,opacity:splashOpacity}}>
        <div style={{position:'absolute',inset:-35,borderRadius:'50%',background:'radial-gradient(circle,#c774e04a,transparent 70%)',opacity:.7+.3*Math.sin(t*Math.PI*2/1.8)}}/>
        <img src={logo} style={{width:140,height:140,position:'relative'}}/>
        <div style={{position:'absolute',top:168,left:-30,width:200,height:2,background:'#ffffff18',overflow:'hidden'}}><div style={{height:2,width:70,background:'linear-gradient(90deg,transparent,#c774e0,transparent)',transform:`translateX(${(t%1.8)/1.8*270-70}px)`}}/></div>
      </div>
      <div id="hero-window" style={{position:'absolute',left:0,top:0,width:1600,height:900,borderRadius:0,overflow:'hidden',boxShadow:'0 28px 100px #0008',opacity:ease(t,2.5,2.64)*(1-end),background:'#050608'}}>
        <ToastProvider><div className="app-shell" style={{height:'100%',position:'relative'}}>
          <Titlebar pinned dynamic={false} collapsed={false} onTogglePin={noop} onToggleWidth={noop}/>
          <div style={{position:'absolute',right:18,top:10,color:'#999',display:'flex',gap:30,fontSize:13}}>— <span>□</span><span>×</span></div>
          <div className="app-body" style={{transformOrigin:'50% 45%',filter:opened?'blur(6px) brightness(.4)':undefined}}>
            <Sidebar route="library" activeRoute="library" onNavigate={noop} clips={shown} filter={filter} dynamic={false} collapsed={false}/>
            <div id="hero-scroll" className="clip-scroll" style={{flex:1,overflow:'hidden',padding:28}}>
              {[...(arrived?[{name:'Today',clips:[shown[0]]}]:[]),{name:'Yesterday',clips:[shown[arrived?1:0]]},{name:'This Week',clips:shown.slice(arrived?2:1)}].map(group=><ClipGroup key={group.name} group={group} thumbnails={new Map(shown.map(c=>[c.originalName,c.thumbnailPath??null]))} grayscaleIcons={false} showNewIndicators collapsed={false} onToggle={noop} layoutHint={null}/>)}

            </div>
          </div>
          <div id="boot-reveal" style={{position:'absolute',display:t<7?'block':'none'}}>
            <div className="boot-cover run"/><div className="boot-vignette run"/>
            <div className="boot-flash run" style={{left:576,top:191,width:448,height:448}}/>
            <img className="boot-hero run" src={logo} style={{left:730,top:345,width:140,height:140}}/>
            {Array.from({length:30},(_,i)=><div key={i} className="boot-mote run" style={{left:340+(i*127)%1050,top:160+(i*79)%580,width:2+i%3,height:2+i%3,'--boot-d':`${100+i*24}ms`,'--boot-dur':`${4400-100-i*24}ms`,'--boot-dx':`${(i%5-2)*20}px`,'--boot-dy':`${-40-i%7*14}px`} as CSSProperties}/>)}
          </div>
          {opened?<div style={{position:'absolute',left:0,top:0,opacity:ease(t,19.4,19.8),transform:`scale(${.96+.04*ease(t,19.4,19.8)})`,transformOrigin:'50% 50%'}}><Player {...playerSpec}/></div>:null}
          <ExportProgress visible={t>=27.1&&t<32} progress={Math.round(ease(t,27.1,29)*100)} clipboard/>

        </div></ToastProvider>
      </div>
      <iframe ref={frame} srcDoc={overlayDocument} title="Clip saved notification" style={{position:'absolute',inset:0,width:1600,height:900,border:0,pointerEvents:'none',visibility:t>=7.2&&t<17?'visible':'hidden',opacity:1-ease(t,16.3,16.8)}}/>
    </div>
    <img src={`file://${String(spec.props?.wallpaper)}`} style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover',opacity:end,pointerEvents:'none'}}/>
  </div>;
}
