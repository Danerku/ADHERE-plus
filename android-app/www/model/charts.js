/* Lightweight SVG chart helpers — offline, dependency-free. */
(function(g){
  function line(series, o){ o=o||{}; var W=o.w||560,H=o.h||220,mL=38,mR=12,mT=12,mB=26;
    var xs=series.map((d,i)=>i), ys=series.map(d=>d.y);
    var yMax=o.yMax!=null?o.yMax:Math.max(...ys,0.001), yMin=o.yMin!=null?o.yMin:0;
    var X=i=>mL+(series.length<2?0:i/(series.length-1))*(W-mL-mR);
    var Y=v=>mT+(1-(v-yMin)/(yMax-yMin))*(H-mT-mB);
    var s='';
    if(o.zones){ // green/amber/red horizontal bands for probability
      s+='<rect x="'+mL+'" y="'+Y(0.33)+'" width="'+(W-mL-mR)+'" height="'+(Y(0)-Y(0.33))+'" fill="#e1f5ee"/>';
      s+='<rect x="'+mL+'" y="'+Y(0.60)+'" width="'+(W-mL-mR)+'" height="'+(Y(0.33)-Y(0.60))+'" fill="#faeeda"/>';
      s+='<rect x="'+mL+'" y="'+Y(yMax)+'" width="'+(W-mL-mR)+'" height="'+(Y(0.60)-Y(yMax))+'" fill="#fcebeb"/>';
    }
    [0,0.25,0.5,0.75,1].forEach(t=>{var yv=yMin+t*(yMax-yMin);s+='<line x1="'+mL+'" y1="'+Y(yv)+'" x2="'+(W-mR)+'" y2="'+Y(yv)+'" stroke="#eee"/><text x="'+(mL-6)+'" y="'+(Y(yv)+4)+'" text-anchor="end" font-size="10" fill="#8a8880">'+(o.pct?Math.round(yv*100)+'%':yv.toFixed(1))+'</text>';});
    if(o.band){ var up=series.map((d,i)=>X(i)+','+Y(d.hi)).join(' '); var dn=series.map((d,i)=>X(i)+','+Y(d.lo)).reverse().join(' ');
      s+='<polygon points="'+up+' '+dn+'" fill="#0f766e22"/>'; }
    var pts=series.map((d,i)=>X(i)+','+Y(d.y)).join(' ');
    s+='<polyline points="'+pts+'" fill="none" stroke="'+(o.stroke||'#0f766e')+'" stroke-width="2"/>';
    series.forEach((d,i)=>{s+='<circle cx="'+X(i)+'" cy="'+Y(d.y)+'" r="3" fill="'+(o.stroke||'#0f766e')+'"/>';
      if(d.x)s+='<text x="'+X(i)+'" y="'+(H-8)+'" text-anchor="middle" font-size="10" fill="#8a8880">'+d.x+'</text>';});
    return '<svg viewBox="0 0 '+W+' '+H+'" width="100%">'+s+'</svg>';
  }
  function gauge(pct, o){ o=o||{}; var col=pct>=0.8?'#0f6e56':pct>=0.5?'#854f0b':'#a32d2d';
    var W=180,H=100,cx=90,cy=92,r=70; function pt(a){return [cx+r*Math.cos(a),cy+r*Math.sin(a)];}
    var a0=Math.PI, a1=Math.PI+pct*Math.PI; var [x0,y0]=pt(a0),[x1,y1]=pt(a1),[xe,ye]=pt(2*Math.PI);
    return '<svg viewBox="0 0 '+W+' '+H+'" width="180"><path d="M'+x0+' '+y0+' A'+r+' '+r+' 0 0 1 '+xe+' '+ye+'" fill="none" stroke="#eee" stroke-width="12"/>'
      +'<path d="M'+x0+' '+y0+' A'+r+' '+r+' 0 '+(pct>0.5?1:0)+' 1 '+x1+' '+y1+'" fill="none" stroke="'+col+'" stroke-width="12"/>'
      +'<text x="'+cx+'" y="'+(cy-6)+'" text-anchor="middle" font-size="26" font-weight="600" fill="'+col+'">'+Math.round(pct*100)+'%</text>'
      +'<text x="'+cx+'" y="'+(cy+12)+'" text-anchor="middle" font-size="11" fill="#8a8880">'+(o.label||'adherence')+'</text></svg>';
  }
  function bars(data, o){ o=o||{}; var W=o.w||560,H=o.h||180,mL=38,mR=12,mT=12,mB=40;
    var mx=Math.max(...data.map(d=>d.v),1),n=data.length,bw=(W-mL-mR)/n*0.6;
    var s=''; data.forEach((d,i)=>{var x=mL+(i+0.2)*((W-mL-mR)/n),h=(d.v/mx)*(H-mT-mB),y=H-mB-h;
      s+='<rect x="'+x+'" y="'+y+'" width="'+bw+'" height="'+h+'" rx="3" fill="'+(d.flag?'#b3261e':'#0d9488')+'"/>'
       +'<text x="'+(x+bw/2)+'" y="'+(y-4)+'" text-anchor="middle" font-size="10" fill="#5f5e5a">'+d.v+'</text>'
       +'<text x="'+(x+bw/2)+'" y="'+(H-8)+'" text-anchor="middle" font-size="10" fill="#8a8880">'+d.x+'</text>';});
    return '<svg viewBox="0 0 '+W+' '+H+'" width="100%">'+s+'</svg>';
  }
  g.Charts={line,gauge,bars};
})(typeof window!=='undefined'?window:global);
if(typeof module!=='undefined') module.exports=(typeof window!=='undefined'?window:global).Charts;
