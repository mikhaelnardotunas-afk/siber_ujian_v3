/* Offline LaTeX subset renderer for SIBER-UJIAN. Uses native MathML; no CDN. */
(function (global) {
  'use strict';
  const SYMBOLS = {alpha:'α',beta:'β',gamma:'γ',theta:'θ',pi:'π',mu:'μ',Delta:'Δ',lambda:'λ',sigma:'σ',omega:'ω',times:'×',cdot:'·',div:'÷',pm:'±',leq:'≤',geq:'≥',neq:'≠',approx:'≈',infty:'∞',degree:'°',rightarrow:'→',leftarrow:'←'};
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function node(tag, body){return '<'+tag+'>'+body+'</'+tag+'>';}
  function parse(src){let i=0;
    function group(){ if(src[i]==='{'){i++;let v=sequence('}');if(src[i]==='}')i++;return v;} return atom(); }
    function atom(){ if(i>=src.length)return '';
      let c=src[i++], out='';
      if(c==='\\') {let m=src.slice(i).match(/^[a-zA-Z]+/); if(m){i+=m[0].length;let cmd=m[0];
        if(cmd==='frac'){let a=group(),b=group();out='<mfrac>'+node('mrow',a)+node('mrow',b)+'</mfrac>';}
        else if(cmd==='sqrt'){out='<msqrt>'+node('mrow',group())+'</msqrt>';}
        else if(cmd==='text'||cmd==='mathrm'){out=node('mtext',esc(strip(group())));}
        else if(cmd==='left'||cmd==='right'){out='';}
        else if(cmd==='quad'||cmd==='qquad'){out='<mspace width="1em"/>';}
        else out=node(SYMBOLS[cmd]?'mo':'mi',esc(SYMBOLS[cmd]||cmd));
      } else if(i<src.length){out=node('mo',esc(src[i++]));}}
      else if(c==='{') {i--;out=group();}
      else if(c==='}') {i--;return '';}
      else if(/[0-9]/.test(c)) out=node('mn',c);
      else if(/[=+\-*/<>|(),.:;]/.test(c)) out=node('mo',esc(c));
      else if(/\s/.test(c)) out='<mspace width="0.25em"/>';
      else out=node(/[a-zA-Z]/.test(c)?'mi':'mo',esc(c));
      if(src[i]==='^'||src[i]==='_'){let sup='',sub='';while(src[i]==='^'||src[i]==='_'){let op=src[i++],v=group();if(op==='^')sup=v;else sub=v;}out=sub&&sup?'<msubsup>'+node('mrow',out)+node('mrow',sub)+node('mrow',sup)+'</msubsup>':sub?'<msub>'+node('mrow',out)+node('mrow',sub)+'</msub>':'<msup>'+node('mrow',out)+node('mrow',sup)+'</msup>';}
      return out;
    }
    function sequence(end){let out='';while(i<src.length&&(end===''||src[i]!==end))out+=atom();return out;}
    function strip(s){return s.replace(/<[^>]+>/g,'');}
    return node('mrow',sequence(''));
  }
  function renderLatex(s,display){return '<math xmlns="http://www.w3.org/1998/Math/MathML" display="'+(display?'block':'inline')+'">'+parse(s)+'</math>';}
  function renderInto(el, value){
    const s=String(value==null?'':value);let out='',i=0;const re=/\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|\$\$([\s\S]*?)\$\$|\$([^$\n]+)\$/g;let m;
    while((m=re.exec(s))){out+=esc(s.slice(i,m.index)).replace(/\n/g,'<br>');const display=m[1]!==undefined||m[3]!==undefined;out+=renderLatex(m[1]??m[2]??m[3]??m[4],display);i=re.lastIndex;}
    out+=esc(s.slice(i)).replace(/\n/g,'<br>');el.innerHTML=out;el.classList.add('latex-content');
  }
  global.MathRenderer={renderInto:renderInto};
})(window);
