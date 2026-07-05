/* Ethiopian <-> Gregorian calendar helper (offline, dependency-free).
   Standard Amete Mihret algorithm via Julian Day Number. */
(function(g){
  function g2jdn(y,m,d){ var a=Math.floor((14-m)/12), y2=y+4800-a, m2=m+12*a-3;
    return d+Math.floor((153*m2+2)/5)+365*y2+Math.floor(y2/4)-Math.floor(y2/100)+Math.floor(y2/400)-32045; }
  function e2jdn(ey,em,ed){ return 1724220 + 365*(ey-1) + Math.floor(ey/4) + 30*(em-1) + ed; }
  function jdn2greg(jdn){ var a=jdn+32044, b=Math.floor((4*a+3)/146097), c=a-Math.floor(146097*b/4);
    var d=Math.floor((4*c+3)/1461), e=c-Math.floor(1461*d/4), m=Math.floor((5*e+2)/153);
    var day=e-Math.floor((153*m+2)/5)+1, month=m+3-12*Math.floor(m/10), year=100*b+d-4800+Math.floor(m/10);
    return {y:year, m:month, d:day}; }
  var MON=['Meskerem','Tikimt','Hidar','Tahsas','Tir','Yekatit','Megabit','Miyazia','Ginbot','Sene','Hamle','Nehase','Pagume'];
  var AMH=['መስከረም','ጥቅምት','ህዳር','ታህሣስ','ጥር','የካቲት','መጋቢት','ሚያዝያ','ግንቦት','ሰኔ','ሐምሌ','ነሐሴ','ጣጉሜን'];
  function toEth(dateOrY,m,d){
    var y; if(dateOrY instanceof Date){ y=dateOrY.getFullYear(); m=dateOrY.getMonth()+1; d=dateOrY.getDate(); } else { y=dateOrY; }
    var jdn=g2jdn(y,m,d);
    var r=(jdn-1723856)%1461; if(r<0)r+=1461;
    var n=(r%365)+365*Math.floor(r/1460);
    var year=4*Math.floor((jdn-1723856)/1461)+Math.floor(r/365)-Math.floor(r/1460);
    var month=Math.floor(n/30)+1, day=(n%30)+1;
    return {year:year, month:month, day:day, monthName:MON[month-1], monthAmh:AMH[month-1]};
  }
  function toGreg(ey,em,ed){ var gg=jdn2greg(e2jdn(+ey,+em,+ed));
    return gg.y+'-'+('0'+gg.m).slice(-2)+'-'+('0'+gg.d).slice(-2); }  // returns 'YYYY-MM-DD'
  function fmt(dateOrY,m,d){ var e=toEth(dateOrY,m,d); return e.monthName+' '+e.day+', '+e.year+' E.C.'; }
  function fmtAmh(dateOrY,m,d){ var e=toEth(dateOrY,m,d); return e.monthAmh+' '+e.day+', '+e.year+' ዓ.ም'; }
  g.Ethiopian={toEth:toEth, toGreg:toGreg, months:MON, monthsAmh:AMH, fmt:fmt, fmtAmh:fmtAmh};
})(typeof window!=='undefined'?window:global);
if(typeof module!=='undefined') module.exports=(typeof window!=='undefined'?window:global).Ethiopian;
