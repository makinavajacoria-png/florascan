const LS={get(k,d){try{return JSON.parse(localStorage.getItem('fs_'+k))??d}catch(e){return d}},set(k,v){localStorage.setItem('fs_'+k,JSON.stringify(v))}};
let stream=null,volverA='jardin',zoomTrack=null,ultimoBlob=null;
const video=document.getElementById('video');
const $=id=>document.getElementById(id);

function show(n){document.querySelectorAll('.sc').forEach(s=>s.classList.remove('on'));$('s-'+n).classList.add('on');
[['n-jardin','jardin'],['n-guia','guia'],['n-ajustes','ajustes']].forEach(p=>{const b=$(p[0]);if(b)b.classList.toggle('sel',p[1]===n)});
if(n==='jardin')pintarJardin();if(n==='guia')pintarGuias();window.scrollTo(0,0)}

function tier(){return LS.get('tier','free')}
function actualizarTier(){$('estadoTier').textContent='Suscripción Estado: '+(tier()==='free'?'Gratis':(tier()==='pro'?'Pro (prueba)':'De por vida'))}
function abrirPaywall(){$('paywall').classList.add('on')}
function cerrarPaywall(){$('paywall').classList.remove('on')}
function activarPro(){LS.set('tier','pro');LS.set('trialFin',Date.now()+7*864e5);actualizarTier();cerrarPaywall();alert('✅ Prueba Pro activada (simulación).');show('jardin')}
function restaurar(){alert(tier()==='free'?'No hay compras anteriores.':'✅ Membresía restaurada: '+tier())}
function limpiarCache(){if(confirm('¿Borrar datos?')){Object.keys(localStorage).filter(k=>k.startsWith('fs_')).forEach(k=>localStorage.removeItem(k));location.reload()}}
function consumirEscaneo(){if(tier()!=='free')return true;const hoy=new Date().toDateString();const u=LS.get('usado_'+hoy,0);if(u>=3){abrirPaywall();return false}LS.set('usado_'+hoy,u+1);return true}

async function abrirCamara(){$('cam').classList.add('on');try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});video.srcObject=stream;await video.play();try{zoomTrack=stream.getVideoTracks()[0];if(zoomTrack.getCapabilities().zoom)$('zoom').max=zoomTrack.getCapabilities().zoom}catch(e){}}catch(e){alert('Error cámara: '+e);cerrarCamara()}}
function cerrarCamara(){if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;$('cam').classList.remove('on')}
function aplicarZoom(v){if(zoomTrack){try{if(zoomTrack.getCapabilities().zoom){zoomTrack.applyConstraints({advanced:[{zoom:+v}]});return}}catch(e){}}video.style.transform='scale('+v+')';video.style.transformOrigin='center'}
function capturar(){const c=document.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;c.getContext('2d').drawImage(video,0,0);cerrarCamara();c.toBlob(analizar,'image/jpeg',0.9)}
async function subir(ev){const f=ev.target.files[0];if(f){cerrarCamara();await analizar(f)}}
function abrirConsejos(){$('modalConsejos').classList.add('on')}
function cerrarConsejos(){$('modalConsejos').classList.remove('on')}

async function prepararBlob(b){try{const bmp=await createImageBitmap(b);const m=1280,e=Math.min(1,m/Math.max(bmp.width,bmp.height));const c=document.createElement('canvas');c.width=Math.round(bmp.width*e);c.height=Math.round(bmp.height*e);c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);return await new Promise(r=>c.toBlob(r,'image/jpeg',0.9))}catch(e){return b}}

async function analizar(blobO){if(!consumirEscaneo())return;const blob=await prepararBlob(blobO);ultimoBlob=blob;show('resultado');$('preview').src=URL.createObjectURL(blob);$('card').style.display='none';$('estado').textContent='Analizando imagen';const fd=new FormData();fd.append('imagen',blob,'foto.jpg');try{const r=await fetch('/analizar',{method:'POST',body:fd});if(!r.ok)throw new Error('Servidor '+r.status);const d=await r.json();guardarJardin(blob,d);pintar(d)}catch(e){$('estado').textContent='❌ Error: '+e.message}}

function guardarJardin(blob,d){const r=new FileReader();r.onload=()=>{const p=LS.get('plantas',[]);p.unshift({id:Date.now(),img:r.result,data:d,fecha:Date.now()});if(p.length>30)p.length=30;LS.set('plantas',p)};r.readAsDataURL(blob)}

function pintarJardin(){const p=LS.get('plantas',[]);$('jardinVacio').style.display=p.length?'none':'block';$('jardin').innerHTML=p.map(x=>{const s=x.data.salud,c=s.estado==='saludable'?'#2EB872':(s.estado==='atencion'?'#D97706':'#DC2626');const nom=x.data.especie.nombre_comun||'Planta';return '<div class="planta" onclick="verDetalle('+x.id+')"><button class="borrar" onclick="event.stopPropagation();eliminarPlanta('+x.id+')">✕</button><img src="'+x.img+'"><div class="txt"><span class="punto" style="background:'+c+'"></span>'+nom+'</div></div>'}).join('')}

function eliminarPlanta(id){if(confirm('¿Eliminar planta?')){LS.set('plantas',LS.get('plantas',[]).filter(x=>x.id!==id));pintarJardin()}}
function verDetalle(id){const p=LS.get('plantas',[]).find(x=>x.id===id);if(p){volverA='jardin';fetch(p.img).then(r=>r.blob()).then(b=>ultimoBlob=b);pintar(p.data);show('resultado')}}

async function pedirInforme(){if(!ultimoBlob){alert('Primero escanea una planta.');return}if(tier()!=='pro'){if(!confirm('Informe detallado: 0,50 € (simulación). ¿Continuar?'))return}$('estado').textContent=' Generando informe...';const fd=new FormData();fd.append('imagen',ultimoBlob,'foto.jpg');try{const r=await fetch('/informe',{method:'POST',body:fd});if(!r.ok)throw new Error('Error '+r.status);const d=await r.json();const a=document.createElement('a');a.href=d.url;a.download='informe_florascan.pdf';document.body.appendChild(a);a.click();document.body.removeChild(a);$('estado').textContent='✅ Informe descargado'}catch(e){alert('Error informe: '+e.message)}}

const GUIAS=[['Potos','Riego cuando esté seco arriba','Luz indirecta'],['Monstera','Sustrato húmedo, sin charcos','Luz brillante'],['Lengua de suegra','Muy escaso','Poca luz'],['Aloe vera','Sustrato seco','Pleno sol'],['Lavanda','Escaso','Pleno sol'],['Olivo','Escaso','Pleno sol'],['Rosal','Regular al pie','Pleno sol'],['Adelfa','Moderado','Pleno sol']];
function pintarGuias(){$('guias').innerHTML=GUIAS.map(g=>'<div class="card"><b>'+g[0]+'</b><p style="font-size:14px;color:#6B7280;margin-top:4px"> '+g[1]+'</p><p style="font-size:14px;color:#6B7280">☀️ '+g[2]+'</p></div>').join('')}

function limpiar(s){return(s||'').split(' (')[0]}
function pintar(d){$('estado').textContent='';$('card').style.display='block';const pn=d.especie.plantnet?d.especie.plantnet[0]:null,lo=d.especie.local?d.especie.local[0]:null;let t='Desconocida',sub='';if(d.especie.nombre_comun&&d.especie.nombre_comun.toLowerCase()!=='no identificada')t=d.especie.nombre_comun;else if(pn)t=pn.nombre_comun||limpiar(pn.nombre_cientifico);else if(lo)t=lo.clase[0].toUpperCase()+lo.clase.slice(1);sub=(pn&&pn.nombre_cientifico)?pn.nombre_cientifico:(lo?lo.clase:'Análisis FloraScan');$('fuente').textContent='🌿 FloraScan';$('nombre').textContent=t;$('cientifico').textContent=sub;const s=d.salud,C=389.6,col=s.estado==='saludable'?'#2EB872':(s.estado==='atencion'?'#D97706':'#DC2626');const ring=$('ring');ring.style.stroke=col;ring.style.strokeDashoffset=C*(1-s.puntuacion/100);$('score').textContent=s.puntuacion+'%';$('estadoSalud').textContent=s.estado==='saludable'?'Saludable':(s.estado==='atencion'?'Atención necesaria':'Crítico');$('sintomas').innerHTML=((s.sintomas&&s.sintomas.length)?s.sintomas:['Sin síntomas visibles']).map(x=>'<li>'+x+'</li>').join('')+(s.diagnostico?'<li style="margin-top:8px;color:#1E9E63"><b>🩺 '+s.diagnostico+'</b></li>':'');$('recomendaciones').innerHTML=((s.recomendaciones&&s.recomendaciones.length)?s.recomendaciones:['Mantén los cuidados habituales']).map(x=>'<li>'+x+'</li>').join('');const c=d.cuidados;$('cuidados').innerHTML=c?'<li><b>'+c.grupo+'</b></li><li>💧 Riego: '+c.riego+'</li><li>☀️ Luz: '+c.luz+'</li><li>⚠️ Su punto débil: '+c.tipico+'</li>':'<li>💧 Riego moderado, buena luz y observa su respuesta.</li>';$('btnInforme').textContent=tier()==='pro'?'📄 Informe detallado (incluido en Pro)':'📄 Informe detallado (0,50 €)'}

show('jardin');actualizarTier();