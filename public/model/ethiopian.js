/* Ethiopian <-> Gregorian calendar helper (offline, dependency-free).
   Standard Amete Mihret algorithm via Julian Day Number. */
(function(g){
  function g2jdn(y,m,d){ var a=Math.floor((14-m)/12), y2=y+4800-a, m2=m+12*a-3;
    return d+Math.floor((153*m2+2)/5)+365*y2+Math.floor(y2/4)-Math.floor(y2/100)+Math.floor(y2/400)-32045; }
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
  function fmt(dateOrY,m,d){ var e=toEth(dateOrY,m,d); return e.monthName+' '+e.day+', '+e.year+' E.C.'; }
  function fmtAmh(dateOrY,m,d){ var e=toEth(dateOrY,m,d); return e.monthAmh+' '+e.day+', '+e.year+' ዓ.ም'; }
  g.Ethiopian={toEth:toEth, fmt:fmt, fmtAmh:fmtAmh};
})(typeof window!=='undefined'?window:global);
if(typeof module!=='undefined') module.exports=(typeof window!=='undefined'?window:global).Ethiopian;
