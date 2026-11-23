/* ==========================================================
   Raio de Distância – Barueri/SP
   - Geocodificação: Nominatim (OpenStreetMap) + ViaCEP para CEPs
   - Distância: fórmula de Haversine
   - Mapa: Leaflet + OpenStreetMap
   ========================================================== */
(function () {
  'use strict';

  /* ---------------- CONFIGURAÇÃO ---------------- */

  // Endereço de referência (pode ser alterado pelo painel ou aqui)
  const DEFAULT_REFERENCE = 'Rua Serra da Cantareira, 237, Barueri - SP';

  // Usado apenas se a geocodificação da referência falhar (centro de Barueri, aprox.)
  const FALLBACK_COORDS = { lat: -23.5113, lng: -46.8761 };

  // Faixas de distância (km). "max" é o limite superior de cada faixa.
  const ZONES = [
    { max: 1, label: 'Até 1 km',  color: '#ef4444', areas: 'Centro, Aldeia de Barueri' },
    { max: 2, label: '1 a 2 km',  color: '#f59e0b', areas: 'Jardim Belval, Alphaville, Vila Pindorama' },
    { max: 3, label: '2 a 3 km',  color: '#22c55e', areas: 'Jardim dos Altos, Alphaville Industrial, Mutinga' },
    { max: 4, label: '3 a 4 km',  color: '#3b82f6', areas: 'Pirapora do Bom Jesus, Santana de Parnaíba' },
    { max: 5, label: '4 a 5 km',  color: '#dc2626', areas: 'Regiões mais afastadas e municípios adjacentes' }
  ];
  // Tabela de pagamento do motoboy: "max" = distância máxima (km) da faixa, tempo em minutos, valor em R$
  const FEES = [
    { max: 0.5, min: 10, fee: 4.99 },  { max: 1,   min: 10, fee: 4.99 },
    { max: 1.5, min: 10, fee: 5.99 },  { max: 2,   min: 10, fee: 5.99 },
    { max: 2.5, min: 10, fee: 6.99 },  { max: 3,   min: 10, fee: 6.99 },
    { max: 3.5, min: 10, fee: 8.99 },  { max: 4,   min: 10, fee: 9.99 },
    { max: 4.5, min: 10, fee: 11.99 }, { max: 5,   min: 10, fee: 11.99 }
  ];
  const feeFor = (km) => FEES.find(f => km <= f.max) || null;
  const fmtMoney = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const OUT_COLOR = '#64748b';
  const MAX_KM = ZONES[ZONES.length - 1].max;

  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  const STORAGE_KEY = 'raio-barueri-historico';
  const REF_KEY = 'raio-barueri-referencia';

  /* ---------------- ESTADO ---------------- */
  let reference = { address: DEFAULT_REFERENCE, lat: FALLBACK_COORDS.lat, lng: FALLBACK_COORDS.lng };
  let results = [];            // consultas da sessão (várias ao mesmo tempo no mapa)
  let history = loadHistory(); // histórico persistente
  let activeId = null;

  /* ---------------- ELEMENTOS ---------------- */
  const $ = (id) => document.getElementById(id);
  const form = $('searchForm'), input = $('searchInput'), btnSearch = $('btnSearch');

  /* ---------------- MAPA ---------------- */
  const map = L.map('map', { zoomControl: true }).setView([reference.lat, reference.lng], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  const ringLayer = L.layerGroup().addTo(map);   // círculos + rótulos + marcador central
  const resultLayer = L.layerGroup().addTo(map); // marcadores/linhas das consultas

  // Legenda dos raios
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = function () {
    const div = L.DomUtil.create('div', 'legend');
    div.innerHTML = '<b>Raios</b><br>' +
      ZONES.map(z => `<i style="background:${z.color}"></i>${z.label}`).join('<br>') +
      `<br><i style="background:${OUT_COLOR}"></i>Acima de ${MAX_KM} km`;
    return div;
  };
  legend.addTo(map);

  /** Desenha marcador central e círculos concêntricos ao redor da referência. */
  function drawRings() {
    ringLayer.clearLayers();
    const c = [reference.lat, reference.lng];

    // Do maior para o menor, para os menores ficarem por cima e clicáveis
    [...ZONES].reverse().forEach(z => {
      L.circle(c, {
        radius: z.max * 1000, color: z.color, weight: 2,
        fillColor: z.color, fillOpacity: 0.07, interactive: false
      }).addTo(ringLayer);

      // Rótulo no topo de cada círculo
      const north = destinationPoint(reference.lat, reference.lng, 0, z.max);
      L.marker(north, {
        interactive: false,
        icon: L.divIcon({ className: 'ring-label', html: `${z.max} km`, iconSize: [40, 14], iconAnchor: [20, 7] })
      }).addTo(ringLayer);
    });

    L.marker(c, { icon: pinIcon('#3b82f6', '★'), zIndexOffset: 1000 })
      .bindPopup(`<b>Ponto de referência</b><br>${esc(reference.address)}`)
      .addTo(ringLayer);

    $('refLabel').textContent = 'Referência: ' + reference.address;
    $('refInput').value = reference.address;
  }

  /** Ícone de pino colorido (CSS inline, sem imagens externas). */
  function pinIcon(color, symbol) {
    return L.divIcon({
      className: '',
      iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14],
      html: `<div style="width:30px;height:30px;border-radius:50%;background:${color};
             border:3px solid #fff;box-shadow:0 2px 6px #0009;color:#fff;
             display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700">${symbol}</div>`
    });
  }

  /* ---------------- CÁLCULOS ---------------- */

  /** Distância em km entre dois pontos (fórmula de Haversine). */
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371.0088; // raio médio da Terra em km
    const rad = (d) => d * Math.PI / 180;
    const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /** Ponto a "km" de distância na direção "bearing" (graus). */
  function destinationPoint(lat, lng, bearing, km) {
    const R = 6371.0088, d = km / R, b = bearing * Math.PI / 180;
    const p1 = lat * Math.PI / 180, l1 = lng * Math.PI / 180;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [p2 * 180 / Math.PI, l2 * 180 / Math.PI];
  }

  /** Retorna a faixa (objeto de ZONES) ou null se estiver fora de 5 km. */
  function zoneFor(km) {
    return ZONES.find(z => km <= z.max) || null;
  }

  const fmtKm = (km) => km.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' km';

  /* ---------------- GEOCODIFICAÇÃO ---------------- */

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /** Uma chamada ao Nominatim. Retorna o primeiro resultado ou null. */
  async function nominatim(params) {
    const url = new URL(NOMINATIM);
    Object.entries({
      format: 'jsonv2', addressdetails: 1, limit: 1, countrycodes: 'br', 'accept-language': 'pt-BR', ...params
    }).forEach(([k, v]) => url.searchParams.set(k, v));
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Serviço de geocodificação indisponível (HTTP ' + resp.status + ').');
    const data = await resp.json();
    return data[0] || null;
  }

  /** Se o texto for um CEP, consulta o ViaCEP e devolve um endereço textual. */
  async function resolveCep(text) {
    const m = text.trim().match(/^(\d{5})-?(\d{3})$/);
    if (!m) return null;
    try {
      const r = await fetch(`https://viacep.com.br/ws/${m[1]}${m[2]}/json/`);
      const d = await r.json();
      if (d.erro) return null;
      return { street: d.logradouro, hood: d.bairro, city: d.localidade, uf: d.uf };
    } catch { return null; }
  }

  /**
   * Localiza um endereço tentando estratégias em ordem, da mais específica à mais ampla.
   * Respeita o limite de 1 requisição/s do Nominatim.
   */
  async function geocode(text) {
    // --- 1. Limpa o texto: separa o CEP, troca " - " por vírgula, expande abreviações ---
    const cepMatch = text.match(/\b\d{5}-?\d{3}\b/);
    const clean = text.replace(/\b\d{5}-?\d{3}\b/, '')
      .replace(/\s+[-–—]\s+/g, ', ')
      .replace(/\bAv\.?(?=\s)/gi, 'Avenida').replace(/\bR\.(?=\s)/gi, 'Rua')
      .replace(/\bAl\.?(?=\s)/gi, 'Alameda').replace(/\bRod\.?(?=\s)/gi, 'Rodovia')
      .replace(/\bEstr\.?(?=\s)/gi, 'Estrada').replace(/\bPç?a\.?(?=\s)/gi, 'Praça')
      .replace(/[,\s]+$/, '').replace(/,\s*,/g, ',').trim();

    // Rua + número (primeiro trecho) e o restante (bairro, cidade...)
    const parts = clean.split(',').map(s => s.trim()).filter(Boolean);
    let street = parts[0] || '', number = '';
    const rest = parts.slice(1);
    const m = street.match(/^(.*\D)\s+(\d+)$/);
    if (m) { street = m[1]; number = m[2]; }
    else if (rest[0] && /^\d+$/.test(rest[0])) { number = rest.shift(); }
    const restTxt = rest.join(', ');
    const hasCity = /barueri|santana de parna|osasco|carapicu|itapevi|jandira|s[ãa]o paulo/i.test(restTxt + ' ' + street);
    const tail = hasCity ? '' : 'Barueri, SP';

    // --- 2. Tentativas, da mais específica à mais ampla ---
    const tries = [];
    if (parts.length) {
      tries.push({ q: clean });
      if (number) tries.push({ q: [`${street} ${number}`, restTxt, tail].filter(Boolean).join(', ') });
      tries.push({ q: [street, restTxt, tail].filter(Boolean).join(', '), noNumber: !!number });
    }
    const cep = await resolveCep(cepMatch ? cepMatch[0] : text);
    if (cep) {
      tries.push({ q: `${cep.street}, ${cep.hood}, ${cep.city}, ${cep.uf}`, noNumber: true });
      tries.push({ q: `${cep.hood}, ${cep.city}, ${cep.uf}`, noNumber: true });
    }

    const seen = new Set();
    let n = 0;
    for (const t of tries) {
      if (!t.q || seen.has(t.q)) continue;
      seen.add(t.q);
      if (n++ > 0) await sleep(1100);
      const hit = await nominatim({ q: t.q });
      if (!hit) continue;
      // Aproximado: pediu número e o resultado não tem, ou o resultado é uma área (bairro/cidade)
      const a = hit.address || {};
      const area = ['suburb', 'neighbourhood', 'quarter', 'city_district', 'city', 'town', 'village', 'municipality', 'state', 'postcode'].includes(hit.addresstype);
      const approximate = area || !!t.noNumber || (!!number && !a.house_number);
      return { hit, approximate };
    }
    return null;
  }

  /** Extrai o bairro/região dos dados geográficos retornados pelo Nominatim. */
  function neighborhoodOf(hit) {
    const a = hit.address || {};
    return a.suburb || a.neighbourhood || a.quarter || a.city_district || a.village || '';
  }
  function cityOf(hit) {
    const a = hit.address || {};
    return a.city || a.town || a.municipality || a.village || '';
  }

  /* ---------------- CONSULTA ---------------- */

  async function search(text) {
    clearMessage();
    btnSearch.disabled = true; btnSearch.textContent = 'Buscando…';
    try {
      const found = await geocode(text);
      if (!found) {
        showMessage('Endereço não encontrado. Confira a grafia ou informe também o bairro e a cidade.', 'error');
        return;
      }
      const { hit, approximate } = found;
      const item = {
        id: Date.now(),
        query: text,
        display: hit.display_name,
        lat: parseFloat(hit.lat), lng: parseFloat(hit.lon),
        hood: neighborhoodOf(hit), city: cityOf(hit),
        approximate
      };
      await fetchRoute(item);
      results.push(item);
      activeId = item.id;
      addHistory(item);
      renderAll(true);
      if (approximate) showMessage('Não foi possível localizar o número exato; a posição é aproximada (rua/bairro).', 'info');
    } catch (err) {
      showMessage('Erro ao consultar: ' + err.message, 'error');
    } finally {
      btnSearch.disabled = false; btnSearch.textContent = 'Consultar';
    }
  }

  /**
   * Busca a rota real por ruas (OSRM, gratuito) entre a referência e o item.
   * Guarda distância (km), tempo e geometria no item. Se falhar, o item usa a linha reta.
   */
  async function fetchRoute(item) {
    delete item.routeKm; delete item.routeCoords; delete item.routeMin;
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${reference.lng},${reference.lat};${item.lng},${item.lat}` +
                  '?overview=full&geometries=geojson';
      const resp = await fetch(url);
      const data = await resp.json();
      if (data.code !== 'Ok' || !data.routes.length) throw new Error('sem rota');
      const r = data.routes[0];
      item.routeKm = r.distance / 1000;
      item.routeMin = r.duration / 60;
      item.routeCoords = r.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    } catch { /* mantém linha reta como alternativa */ }
  }

  /** Distância e faixa de um item: pela rota real quando disponível, senão em linha reta. */
  function measure(item) {
    const straight = haversine(reference.lat, reference.lng, item.lat, item.lng);
    const km = item.routeKm ?? straight;
    return { km, straight, byRoute: item.routeKm != null, zone: zoneFor(km) };
  }

  /* ---------------- RENDERIZAÇÃO ---------------- */

  /** Atualiza mapa, painel de resultado, faixas e histórico. */
  function renderAll(fit) {
    renderMap(fit);
    renderResult();
    renderZones();
    renderFees();
    renderHistory();
  }

  function renderMap(fit) {
    resultLayer.clearLayers();
    const bounds = L.latLngBounds([[reference.lat, reference.lng]]);

    results.forEach(item => {
      const { km, zone } = measure(item);
      const color = zone ? zone.color : OUT_COLOR;
      const isActive = item.id === activeId;

      // Rota real pelas ruas; se indisponível, linha reta tracejada
      const line = item.routeCoords || [[reference.lat, reference.lng], [item.lat, item.lng]];
      L.polyline(line, {
        color: isActive ? '#fff' : color, weight: isActive ? 4 : 3,
        dashArray: item.routeCoords ? null : '6 6', opacity: isActive ? 0.95 : 0.6
      }).addTo(resultLayer);
      if (isActive || fit) line.forEach(p => bounds.extend(p));

      const marker = L.marker([item.lat, item.lng], {
        icon: pinIcon(color, '●'), zIndexOffset: isActive ? 900 : 500
      }).bindPopup(`<b>${fmtKm(km)}</b><br>${esc(item.display)}`).addTo(resultLayer);
      marker.on('click', () => { activeId = item.id; renderResult(); renderZones(); renderFees(); renderMap(false); });
      if (isActive) { marker.openPopup(); }

      if (isActive || fit) bounds.extend([item.lat, item.lng]);
    });

    if (fit && results.length) map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
  }

  function renderResult() {
    const body = $('resultBody');
    const item = results.find(r => r.id === activeId);
    if (!item) { body.className = 'empty'; body.innerHTML = 'Digite um endereço e clique em <b>Consultar</b>.'; return; }

    const { km, straight, byRoute, zone } = measure(item);
    const color = zone ? zone.color : OUT_COLOR;
    const verdict = zone
      ? `Dentro do raio de ${zone.max} km`
      : `Fora do raio de cobertura (acima de ${MAX_KM} km)`;
    const place = [item.hood, item.city].filter(Boolean).join(' – ');

    body.className = '';
    body.innerHTML = `
      <div class="result-distance" style="color:${color}">${fmtKm(km)}</div>
      <p class="result-address">${esc(item.display)}</p>
      <span class="badge" style="background:${color}">${verdict}</span>
      ${(() => { const f = feeFor(km); return f
        ? `<div class="delivery"><div><span>Pagar ao motoboy</span><b>${fmtMoney(f.fee)}</b></div>
           <div><span>Tempo</span><b>${f.min} min</b></div></div>`
        : `<div class="delivery out"><span>Sem entrega: fora da área de cobertura</span></div>`; })()}
      ${feeFor(km) ? saveBlock() : ''}
      <p class="result-row"><span>Distância:</span> ${byRoute ? 'pela rota real (ruas)' : 'em linha reta (rota indisponível)'}</p>
      ${byRoute ? `<p class="result-row"><span>Em linha reta:</span> ${fmtKm(straight)}</p>` : ''}
      <p class="result-row"><span>Faixa:</span> ${zone ? zone.label : 'Acima de ' + MAX_KM + ' km'}</p>
      <p class="result-row"><span>Limite de ${MAX_KM} km:</span> ${zone ? '✅ Dentro' : '❌ Fora'}</p>
      ${place ? `<p class="result-row"><span>Bairro/Região (OpenStreetMap):</span> ${esc(place)}</p>` : ''}
      <p class="result-row"><span>Coordenadas:</span> ${item.lat.toFixed(5)}, ${item.lng.toFixed(5)}</p>`;
  }

  /** Bloco "salvar entrega no perfil do motoboy". */
  function saveBlock() {
    const d = Store.load();
    if (!d.motoboys.length) {
      return '<p class="result-row"><a class="link" href="motoboys.html">Cadastre um motoboy</a> para salvar entregas.</p>';
    }
    const opts = d.motoboys.map(m =>
      `<option value="${m.id}" ${m.id === d.lastMoto ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
    return `<div class="save-box">
      <select id="selMoto" aria-label="Motoboy">${opts}</select>
      <button type="button" id="btnSaveDelivery" class="btn primary">Salvar entrega</button></div>`;
  }

  function renderZones() {
    const item = results.find(r => r.id === activeId);
    const active = item ? measure(item).zone : null;
    $('zoneList').innerHTML = ZONES.map(z => `
      <li style="--c:${z.color}" class="${active === z ? 'active' : ''}">
        <strong>${z.label}</strong><span>${esc(z.areas)}</span>
      </li>`).join('');
  }

  /** Tabela de preços; destaca a linha da consulta ativa. */
  function renderFees() {
    const item = results.find(r => r.id === activeId);
    const cur = item ? feeFor(measure(item).km) : null;
    $('feeBody').innerHTML = FEES.map(f => `
      <tr class="${f === cur ? 'active' : ''}">
        <td>${f.max.toLocaleString('pt-BR')} km</td><td>${f.min} min</td><td>${fmtMoney(f.fee)}</td></tr>`).join('');
  }

  function renderHistory() {
    const ul = $('historyList');
    if (!history.length) { ul.innerHTML = '<li class="empty">Nenhuma consulta ainda.</li>'; return; }
    ul.innerHTML = history.map((h, i) => {
      const { km, zone } = measure(h);
      return `<li><button type="button" data-i="${i}" title="${esc(h.display)}">
        <span class="h-addr">${esc(h.query)}</span>
        <span class="h-dist" style="color:${zone ? zone.color : OUT_COLOR}">${fmtKm(km)}</span></button></li>`;
    }).join('');
  }

  /* ---------------- HISTÓRICO (localStorage) ---------------- */

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; }
  }
  function saveHistory() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(history)); } catch { /* ignora */ }
  }
  function addHistory(item) {
    // Salva sem a geometria da rota (pesada); guarda só a distância
    const { routeCoords, ...slim } = item;
    history = [slim, ...history.filter(h => h.display !== item.display)].slice(0, 20);
    saveHistory();
  }

  /* ---------------- UTILIDADES ---------------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function showMessage(text, type) {
    const el = $('message'); el.textContent = text; el.className = 'message ' + type; el.hidden = false;
  }
  function clearMessage() { $('message').hidden = true; }

  /* ---------------- REFERÊNCIA ---------------- */

  /** Geocodifica e aplica um novo endereço de referência; recalcula tudo. */
  async function setReference(address, silent) {
    try {
      const found = await geocode(address);
      if (!found) throw new Error('não encontrado');
      reference = { address, lat: parseFloat(found.hit.lat), lng: parseFloat(found.hit.lon) };
      try { localStorage.setItem(REF_KEY, address); } catch { /* ignora */ }
    } catch {
      if (!silent) { showMessage('Não foi possível localizar o novo endereço de referência.', 'error'); return; }
      showMessage('Não foi possível geocodificar a referência; usando posição aproximada do centro de Barueri.', 'info');
      reference = { address, lat: FALLBACK_COORDS.lat, lng: FALLBACK_COORDS.lng };
    }
    drawRings();
    // Referência mudou: rotas antigas ficam inválidas
    history.forEach(h => { delete h.routeKm; delete h.routeMin; });
    await Promise.all(results.map(fetchRoute));
    renderAll(false);
    map.setView([reference.lat, reference.lng], 14);
  }

  /* ---------------- EVENTOS ---------------- */

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (text) search(text);
  });

  $('btnClear').addEventListener('click', () => {
    input.value = ''; results = []; activeId = null;
    clearMessage(); renderAll(false); goCenter();
  });

  // Salvar a entrega ativa no perfil do motoboy escolhido
  const LEADER_PASS = 'admin'; // senha de líder para salvar uma entrega repetida

  /** Grava a entrega ativa para o motoboy selecionado. */
  function doSave(item) {
    const motoId = $('selMoto').value;
    const { km } = measure(item);
    const f = feeFor(km);
    if (!motoId || !f) return;
    Store.addEntrega({
      motoboyId: motoId, address: item.display, km, fee: f.fee, min: f.min, at: new Date().toISOString()
    });
    const name = Store.load().motoboys.find(m => m.id === motoId)?.name || '';
    const box = $('overrideBox'); if (box) box.remove();
    showMessage(`Entrega salva para ${name}: ${fmtMoney(f.fee)} (${fmtKm(km)}).`, 'info');
  }

  $('resultBody').addEventListener('click', (e) => {
    const item = results.find(r => r.id === activeId);
    if (!item) return;

    if (e.target.closest('#btnSaveDelivery')) {
      // Mesmo endereço, no mesmo dia, só pode ser salvo uma vez
      const today = Store.dayKey(new Date());
      const d = Store.load();
      const dup = d.entregas.find(x => x.address === item.display && Store.dayKey(x.at) === today);
      if (!dup) { doSave(item); return; }

      const who = d.motoboys.find(m => m.id === dup.motoboyId)?.name || 'outro motoboy';
      const hora = new Date(dup.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      showMessage(`Já foi salvo: esta entrega está no perfil de ${who} (hoje, ${hora}). Para salvar novamente, informe a senha de líder.`, 'error');
      if (!$('overrideBox')) {
        e.target.closest('.save-box').insertAdjacentHTML('afterend',
          `<div class="save-box" id="overrideBox">
             <input id="leaderPass" type="password" placeholder="Senha de líder" aria-label="Senha de líder">
             <button type="button" id="btnOverride" class="btn">Salvar mesmo assim</button></div>`);
      }
      return;
    }

    if (e.target.closest('#btnOverride')) {
      if ($('leaderPass').value === LEADER_PASS) doSave(item);
      else showMessage('Senha de líder incorreta.', 'error');
    }
  });

  $('btnLogout').addEventListener('click', () => {
    try { sessionStorage.removeItem('raio-barueri-sessao'); } catch { /* ignora */ }
    location.replace('login.html');
  });

  $('btnClearHistory').addEventListener('click', () => {
    history = []; saveHistory(); renderHistory();
  });

  $('historyList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-i]');
    if (!btn) return;
    const h = history[+btn.dataset.i];
    // Reaproveita as coordenadas salvas (sem nova geocodificação); refaz só a rota
    let item = results.find(r => r.display === h.display);
    if (!item) { item = { ...h, id: Date.now() }; await fetchRoute(item); results.push(item); }
    activeId = item.id;
    input.value = h.query;
    renderAll(true);
  });

  function goCenter() { map.setView([reference.lat, reference.lng], 14); }
  $('btnCenter').addEventListener('click', goCenter);

  $('refForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('refInput').value.trim();
    if (v) setReference(v, false);
  });

  /* ---------------- INICIALIZAÇÃO ---------------- */

  drawRings();
  renderAll(false);
  let saved = null;
  try { saved = localStorage.getItem(REF_KEY); } catch { /* ignora */ }
  setReference(saved || DEFAULT_REFERENCE, true);
})();
