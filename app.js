const LS={get(k,d){try{const v=JSON.parse(localStorage.getItem('fs_'+k));return v===null||v===undefined?d:v}catch(e){return d}},set(k,v){localStorage.setItem('fs_'+k,JSON.stringify(v))}};
let stream=null,volverA='jardin',zoomTrack=null;
const video=document.getElementById('video');
const $=id=>document.getElementById(id);

function show(n){document.querySelectorAll('.sc').forEach(s=>s.classList.remove('on'));$('s-'+n).classList.add('on');
[['n-jardin','jardin'],['n-guia','guia'],['n-ajustes','ajustes']].forEach(p=>{const b=$(p[0]);if(b)b.classList.toggle('sel',p[1]===n)});
if(n==='jardin')pintarJardin();if(n==='guia')pintarGuias();window.scrollTo(0,0)}

function tier(){return LS.get('tier','free')}
function actualizarTier(){const t=tier();$('estadoTier').textContent='Suscripción Estado: '+(t==='free'?'Gratis':(t==='pro'?'Pro (prueba)':'De por vida'))}
function abrirPaywall(){$('paywall').classList.add('on')}
function cerrarPaywall(){$('paywall').classList.remove('on')}
function activarPro(){LS.set('tier','pro');LS.set('trialFin',Date.now()+7*864e5);actualizarTier();cerrarPaywall();alert('✅ Prueba Pro de 7 días activada (simulación). En producción esto sería el pago real de Google Play.');show('jardin')}
function restaurar(){const t=tier();alert(t==='free'?'No se encontraron compras anteriores.':'✅ Membresía restaurada: '+t)}
function limpiarCache(){if(confirm('¿Borrar jardín y datos guardados?')){Object.keys(localStorage).filter(k=>k.startsWith('fs_')).forEach(k=>localStorage.removeItem(k));location.reload()}}

function consumirEscaneo(){if(tier()!=='free')return true;const hoy=new Date().toDateString();const u=LS.get('usado_'+hoy,0);
if(u>=3){abrirPaywall();return false}LS.set('usado_'+hoy,u+1);return true}

async function abrirCamara(){$('cam').classList.add('on');
try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});video.srcObject=stream;await video.play();
try{zoomTrack=stream.getVideoTracks()[0];const c=zoomTrack.getCapabilities();if(c&&c.zoom)$('zoom').max=c.zoom}catch(e){}
}catch(e){alert('No se pudo abrir la cámara: '+e);cerrarCamara()}}
function cerrarCamara(){if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;$('cam').classList.remove('on')}
function aplicarZoom(v){if(zoomTrack){try{const c=zoomTrack.getCapabilities();if(c&&c.zoom){zoomTrack.applyConstraints({advanced:[{zoom:+v}]});return}}catch(e){}}video.style.transform='scale('+v+')';video.style.transformOrigin='center'}
function capturar(){const c=document.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;c.getContext('2d').drawImage(video,0,0);cerrarCamara();c.toBlob(analizar,'image/jpeg',0.9)}
async function subir(ev){const f=ev.target.files[0];if(f){cerrarCamara();await analizar(f)}}
function abrirConsejos(){$('modalConsejos').classList.add('on')}
function cerrarConsejos(){$('modalConsejos').classList.remove('on')}

async function prepararBlob(b){try{const bmp=await createImageBitmap(b);const m=1280,e=Math.min(1,m/Math.max(bmp.width,bmp.height));const c=document.createElement('canvas');c.width=Math.round(bmp.width*e);c.height=Math.round(bmp.height*e);c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);return await new Promise(r=>c.toBlob(r,'image/jpeg',0.9))}catch(e){return b}}

async function analizar(blobO){if(!consumirEscaneo())return;const blob=await prepararBlob(blobO);
show('resultado');$('preview').src=URL.createObjectURL(blob);$('card').style.display='none';$('estado').textContent='🔬 Analizando con IA...';
const fd=new FormData();fd.append('imagen',blob,'foto.jpg');
try{const r=await fetch('/analizar',{method:'POST',body:fd});if(!r.ok)throw new Error('Servidor '+r.status);
const d=await r.json();guardarJardin(blob,d);pintar(d)}catch(e){$('estado').textContent='❌ Error: '+e.message}}

function guardarJardin(blob,d){const r=new FileReader();r.onload=()=>{const p=LS.get('plantas',[]);p.unshift({id:Date.now(),img:r.result,data:d,fecha:Date.now()});if(p.length>30)p.length=30;LS.set('plantas',p)};r.readAsDataURL(blob)}

function pintarJardin(){const p=LS.get('plantas',[]);$('jardinVacio').style.display=p.length?'none':'block';
$('jardin').innerHTML=p.map(x=>{const s=x.data.salud,c=s.estado==='saludable'?'#2EB872':(s.estado==='atencion'?'#D97706':'#DC2626');
const nom=x.data.especie.nombre_comun||'Planta';const dias=(x.data.cuidados&&x.data.cuidados.riego&&/Escaso|Muy escaso/i.test(x.data.cuidados.riego))?10:5;
const due=((Date.now()-x.fecha)/864e5)>=dias;
return '<div class="planta" onclick="verDetalle('+x.id+')"><img src="'+x.img+'"><div class="txt"><span class="punto" style="background:'+c+'"></span>'+nom+(due?'<span class="badge-riego">💧 Toca revisar riego</span>':'')+'</div></div>'}).join('')}

function verDetalle(id){const p=LS.get('plantas',[]).find(x=>x.id===id);if(p){volverA='jardin';pintar(p.data);show('resultado')}}

const GUIAS=[['Potos / Pothos','Riego cuando los 2-3 cm superiores estén secos','Luz brillante indirecta'],['Monstera','Sustrato ligeramente húmedo, sin encharcar','Luz indirecta brillante'],['Lengua de suegra','Muy escaso: solo con sustrato totalmente seco','Tolera poca luz y sol suave'],['Aloe vera','Solo cuando el sustrato esté seco','Pleno sol o luz muy brillante'],['Lavanda','Escaso, deja secar entre riegos','Pleno sol'],['Olivo','Escaso una vez establecido','Pleno sol'],['Rosal','Regular al pie, sin mojar hojas','Pleno sol ventilado'],['Adelfa','Moderado; tolera sequía establecida','Pleno sol']];
function pintarGuias(){$('guias').innerHTML=GUIAS.map(g=>'<div class="card"><b>'+g[0]+'</b><p style="font-size:14px;color:#6B7280;margin-top:4px">💧 '+g[1]+'</p><p style="font-size:14px;color:#6B7280">☀️ '+g[2]+'</p></div>').join('')}

function limpiar(s){return(s||'').split(' (')[0]}
function pintar(d){$('estado').textContent='';$('card').style.display='block';
const pn=d.especie.plantnet?d.especie.plantnet[0]:null,lo=d.especie.local?d.especie.local[0]:null;
let t='Desconocida',sub='',f='';
if((d.especie.fuente==='gemini'||d.especie.fuente==='qwen')&&d.especie.nombre_comun){t=d.especie.nombre_comun;sub='Diagnóstico por IA';f=d.especie.fuente==='qwen'?'🤖 Qwen AI':'🤖 Gemini AI'}
else if(d.especie.fuente==='plantnet'&&pn){t=pn.nombre_comun||limpiar(pn.nombre_cientifico);sub=pn.nombre_cientifico;f='Pl@ntNet · '+Math.round(pn.confianza*100)+'%'}
else if(lo){t=lo.clase[0].toUpperCase()+lo.clase.slice(1);sub='Modelo local';f='Local · '+Math.round(lo.confianza*100)+'%'}
$('fuente').textContent=f;$('nombre').textContent=t;$('cientifico').textContent=sub;
const s=d.salud,C=389.6,col=s.estado==='saludable'?'#2EB872':(s.estado==='atencion'?'#D97706':'#DC2626');
const ring=$('ring');ring.style.stroke=col;ring.style.strokeDashoffset=C*(1-s.puntuacion/100);
$('score').textContent=s.puntuacion+'%';$('estadoSalud').textContent=s.estado==='saludable'?'Saludable':(s.estado==='atencion'?'Atención necesaria':'Crítico');
$('sintomas').innerHTML=((s.sintomas&&s.sintomas.length)?s.sintomas:['Sin síntomas visibles']).map(x=>'<li>'+x+'</li>').join('')+(s.diagnostico?'<li style="margin-top:8px;color:#1E9E63"><b>🩺 '+s.diagnostico+'</b></li>':'');
$('recomendaciones').innerHTML=((s.recomendaciones&&s.recomendaciones.length)?s.recomendaciones:['Mantén los cuidados habituales']).map(x=>'<li>'+x+'</li>').join('');
const c=d.cuidados;$('cuidados').innerHTML=c?'<li><b>'+c.grupo+'</b></li><li>💧 Riego: '+c.riego+'</li><li>☀️ Luz: '+c.luz+'</li><li>⚠️ Su punto débil: '+c.tipico+'</li>':'<li>💧 Riego moderado, buena luz y observa su respuesta.</li>'}

show('jardin');actualizarTier();
