/* ==========================================================
   RAIO DELIVERY – calculadora de frete para comerciantes
   - Geocodificação: Nominatim (OpenStreetMap) + ViaCEP para CEPs
   - Distância principal: rota real pelas ruas (OSRM)
   - Linha reta (Haversine): apenas informativa, nunca define o preço
   - Mapa: Leaflet + OpenStreetMap
   ========================================================== */
(function () {
  'use strict';

  /* ---------------- CONFIGURAÇÃO ---------------- */

  // Endereço de referência padrão (pode ser alterado pelo painel)
  const DEFAULT_REFERENCE = 'Rua Serra da Cantareira, 237, Barueri - SP';

  // Usado só para posicionar o mapa enquanto a referência não é localizada.
  // Nunca é usado em cálculos.
  const MAP_START = { lat: -23.5113, lng: -46.8761 };

  // Faixas visuais do mapa (km). "max" é o limite superior de cada faixa.
  const ZONES = [
    { max: 1, label: 'Até 1 km',  color: '#ef4444', areas: 'Centro, Aldeia de Barueri' },
    { max: 2, label: '1 a 2 km',  color: '#f59e0b', areas: 'Jardim Belval, Alphaville, Vila Pindorama' },
    { max: 3, label: '2 a 3 km',  color: '#22c55e', areas: 'Jardim dos Altos, Alphaville Industrial, Mutinga' },
    { max: 4, label: '3 a 4 km',  color: '#3b82f6', areas: 'Pirapora do Bom Jesus, Santana de Parnaíba' },
    { max: 5, label: '4 a 5 km',  color: '#dc2626', areas: 'Regiões mais afastadas e municípios adjacentes' }
  ];

  // Tabela de pagamento do motoboy: "max" = distância máxima (km), "min" = tempo (min), "fee" = valor (R$)
  const FEES_KEY = 'raio-barueri-tabela-motoboy';
  const DEFAULT_FEES = [
    { max: 0.5, min: 10, fee: 4.99 },  { max: 1,   min: 10, fee: 4.99 },
    { max: 1.5, min: 10, fee: 5.99 },  { max: 2,   min: 10, fee: 5.99 },
    { max: 2.5, min: 10, fee: 6.99 },  { max: 3,   min: 10, fee: 6.99 },
    { max: 3.5, min: 10, fee: 8.99 },  { max: 4,   min: 10, fee: 9.99 },
    { max: 4.5, min: 10, fee: 11.99 }, { max: 5,   min: 10, fee: 11.99 }
  ];

  /** Tabela em uso: a salva pelo administrador (localStorage) ou a padrão acima. */
  function loadFees() {
    try {
      const s = JSON.parse(localStorage.getItem(FEES_KEY));
      if (Array.isArray(s) && s.length) return s;
    } catch { /* usa o padrão */ }
    return DEFAULT_FEES.map(f => ({ ...f }));
  }
  let FEES = loadFees();
  let feesEditing = false, feesDraft = [];

  /** Linha da tabela que cobre a distância (km), ou null se passar do último raio. */
  const feeFor = (km) => FEES.find(f => km <= f.max) || null;
  const fmtMoney = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtKm = (km) => km.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' km';
  const OUT_COLOR = '#64748b';
  const MAX_KM = ZONES[ZONES.length - 1].max;

  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  const STORAGE_KEY = 'raio-barueri-historico';
  const REF_KEY = 'raio-barueri-referencia'; // JSON: { address, lat, lng }
  const TIMEOUT = 15000;                     // tempo máximo de cada chamada de rede (ms)

  /* ---------------- ESTADO ---------------- */
  // ok = referência realmente localizada (sem isso, nenhum cálculo é feito)
  let reference = { address: DEFAULT_REFERENCE, lat: MAP_START.lat, lng: MAP_START.lng, ok: false };
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
  const resultLayer = L.layerGroup().addTo(map); // marcadores/rotas das consultas

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
    $('refInput').value = reference.address;

    if (!reference.ok) {
      $('refLabel').textContent = 'Referência: não localizada';
      $('refCoords').textContent = 'Endereço de referência não localizado.';
      return;
    }
    const c = [reference.lat, reference.lng];

    // Do maior para o menor, para os menores ficarem por cima
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
    $('refCoords').textContent = `Coordenadas: ${reference.lat.toFixed(5)}, ${reference.lng.toFixed(5)}`;
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

  /** Distância em km entre dois pontos (fórmula de Haversine). Só informativa. */
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

  /** Faixa visual (objeto de ZONES) ou null se estiver acima de 5 km. */
  function zoneFor(km) {
    return ZONES.find(z => km <= z.max) || null;
  }

  /**
   * Medidas de uma consulta. Faixa e valor dependem SOMENTE da rota real:
   * sem rota (byRoute = false) não há faixa nem valor.
   */
  function measure(item) {
    const straight = haversine(reference.lat, reference.lng, item.lat, item.lng);
    const byRoute = item.routeKm != null;
    const km = byRoute ? item.routeKm : null;
    return {
      km, straight, byRoute,
      zone: byRoute ? zoneFor(km) : null,
      row: byRoute ? feeFor(km) : null   // linha da tabela de preços
    };
  }

  /* ---------------- GEOCODIFICAÇÃO ---------------- */

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /** Uma chamada ao Nominatim. Retorna o primeiro resultado ou null. */
  async function nominatim(params) {
    const url = new URL(NOMINATIM);
    Object.entries({
      format: 'jsonv2', addressdetails: 1, limit: 1, countrycodes: 'br', 'accept-language': 'pt-BR', ...params
    }).forEach(([k, v]) => url.searchParams.set(k, v));
    const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!resp.ok) throw new Error('Serviço de geocodificação indisponível (HTTP ' + resp.status + ').');
    const data = await resp.json();
    return data[0] || null;
  }

  /** Se o texto for um CEP, consulta o ViaCEP e devolve um endereço textual. */
  async function resolveCep(text) {
    const m = text.trim().match(/^(\d{5})-?(\d{3})$/);
    if (!m) return null;
    try {
      const r = await fetch(`https://viacep.com.br/ws/${m[1]}${m[2]}/json/`, { signal: AbortSignal.timeout(TIMEOUT) });
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

  /* ---------------- ROTA REAL ---------------- */

  /**
   * Busca a rota pelas ruas (OSRM, gratuito) entre a referência e o item.
   * Guarda distância (km), tempo e geometria no item. Em caso de falha não define
   * routeKm: a consulta fica SEM valor (nunca se usa a linha reta como preço).
   */
  async function fetchRoute(item) {
    delete item.routeKm; delete item.routeCoords; delete item.routeMin;
    if (!reference.ok) return;
    const url = `https://router.project-osrm.org/route/v1/driving/${reference.lng},${reference.lat};${item.lng},${item.lat}` +
                '?overview=full&geometries=geojson';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
        const data = await resp.json();
        if (data.code !== 'Ok' || !data.routes.length) throw new Error('sem rota');
        const r = data.routes[0];
        item.routeKm = r.distance / 1000;
        item.routeMin = r.duration / 60;
        item.routeCoords = r.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
        return;
      } catch { await sleep(600); }
    }
  }

  /* ---------------- CONSULTA ---------------- */

  async function search(text) {
    clearMessage();
    if (!reference.ok) {
      showMessage('O endereço de referência não foi localizado. Defina-o em "Alterar endereço de referência" para calcular.', 'error');
      return;
    }
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
        cep: (hit.address && hit.address.postcode) || '',
        approximate,
        motoId: lastMotoId()
      };
      await fetchRoute(item);
      results.push(item);
      activeId = item.id;
      addHistory(item);
      renderAll(true);
      if (item.routeKm == null) {
        showMessage('Endereço localizado, mas não foi possível calcular a rota pelas ruas agora. O valor não pode ser definido; tente novamente.', 'error');
      } else if (approximate) {
        showMessage('Localização aproximada: não foi possível localizar o número exato (posição de rua/bairro).', 'info');
      }
    } catch (err) {
      showMessage('Erro ao consultar: ' + (err.name === 'TimeoutError' ? 'tempo esgotado, tente novamente.' : err.message), 'error');
    } finally {
      btnSearch.disabled = false; btnSearch.textContent = 'Consultar';
    }
  }

  /** Último motoboy escolhido, se ainda existir. */
  function lastMotoId() {
    const d = Store.load();
    return d.motoboys.some(m => m.id === d.lastMoto) ? d.lastMoto : '';
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
      const { km, byRoute, zone } = measure(item);
      const color = zone ? zone.color : OUT_COLOR;
      const isActive = item.id === activeId;

      // Rota real pelas ruas; se indisponível, só uma linha tracejada de referência visual
      const line = item.routeCoords || [[reference.lat, reference.lng], [item.lat, item.lng]];
      L.polyline(line, {
        color: isActive ? '#fff' : color, weight: isActive ? 4 : 3,
        dashArray: item.routeCoords ? null : '6 6', opacity: isActive ? 0.95 : 0.6
      }).addTo(resultLayer);
      if (isActive || fit) line.forEach(p => bounds.extend(p));

      const marker = L.marker([item.lat, item.lng], {
        icon: pinIcon(color, '●'), zIndexOffset: isActive ? 900 : 500
      }).bindPopup(`<b>${byRoute ? fmtKm(km) : 'Rota indisponível'}</b><br>${esc(item.display)}`).addTo(resultLayer);
      marker.on('click', () => { activeId = item.id; renderResult(); renderZones(); renderFees(); renderMap(false); });
      if (isActive) { marker.openPopup(); }

      if (isActive || fit) bounds.extend([item.lat, item.lng]);
    });

    if (fit && results.length) map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
  }

  /** Card de resultado: o valor a pagar é o destaque principal. */
  function renderResult() {
    const body = $('resultBody');
    const item = results.find(r => r.id === activeId);
    if (!item) { body.className = 'empty'; body.innerHTML = 'Digite um endereço e clique em <b>Consultar</b>.'; return; }

    const { km, straight, byRoute, zone, row } = measure(item);
    const place = [item.hood, item.city].filter(Boolean).join(' – ');
    const lastMax = FEES.length ? FEES[FEES.length - 1].max : 0;

    let price;
    if (!byRoute) {
      price = `<div class="price warn"><span>Valor a pagar ao motoboy</span><b>—</b>
        <small>Rota pelas ruas indisponível: sem ela o valor não pode ser definido.</small>
        <button type="button" id="btnRetryRoute" class="btn">Tentar novamente</button></div>`;
    } else if (!row) {
      price = `<div class="price warn"><span>Valor a pagar ao motoboy</span><b>—</b>
        <small>Distância acima de ${lastMax.toLocaleString('pt-BR')} km: fora da tabela de preços.</small></div>`;
    } else {
      price = `<div class="price"><span>Valor a pagar ao motoboy</span><b>${fmtMoney(row.fee)}</b></div>`;
    }

    const prev = item.prev
      ? `<p class="result-row"><span>Valor calculado anteriormente:</span> ${fmtMoney(item.prev.fee)}` +
        `${item.prev.at ? ' em ' + new Date(item.prev.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : ''}</p>`
      : '';

    body.className = '';
    body.innerHTML = `
      ${price}
      <p class="result-row"><span>Endereço:</span> ${esc(item.display)}</p>
      ${item.approximate ? '<p class="result-row approx">⚠ Localização aproximada</p>' : ''}
      <p class="result-row"><span>Distância real (pela rota):</span> <b>${byRoute ? fmtKm(km) : 'indisponível'}</b></p>
      <p class="result-row"><span>Distância em linha reta:</span> ${fmtKm(straight)}</p>
      <p class="result-row"><span>Bairro:</span> ${place ? esc(place) : 'não identificado'}</p>
      <p class="result-row"><span>Faixa:</span> ${byRoute ? (zone ? zone.label : 'Acima de ' + MAX_KM + ' km') : '—'}</p>
      <p class="result-row"><span>Tempo estimado:</span> ${row ? row.min + ' min' : '—'}</p>
      ${prev}
      ${motoBlock(item)}`;
  }

  /** Seletor opcional: identifica a qual motoboy se destina a consulta. */
  function motoBlock(item) {
    const d = Store.load();
    if (!d.motoboys.length) {
      return '<p class="result-row"><a class="link" href="motoboys.html">Cadastrar motoboy</a> (opcional)</p>';
    }
    const opts = d.motoboys.map(m =>
      `<option value="${m.id}" ${m.id === item.motoId ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
    // Só há o que salvar quando existe valor calculado pela rota
    const canSave = measure(item).row != null;
    return `<div class="save-box"><select id="selMoto" aria-label="Motoboy desta consulta">
      <option value="">Selecione o motoboy</option>${opts}</select>
      ${canSave ? '<button type="button" id="btnSaveDelivery" class="btn primary">Salvar entrega</button>' : ''}</div>`;
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
    $('btnEditFees').hidden = feesEditing;
    $('feeActions').hidden = !feesEditing;

    if (feesEditing) {
      $('feeBody').innerHTML = feesDraft.map((f, i) => `
        <tr>
          <td><input type="number" class="cell" data-i="${i}" data-k="max" min="0.1" step="0.5" value="${f.max}" aria-label="Raio (km)"></td>
          <td><input type="number" class="cell" data-i="${i}" data-k="min" min="0" step="1" value="${f.min}" aria-label="Tempo (min)"></td>
          <td><input type="number" class="cell" data-i="${i}" data-k="fee" min="0" step="0.01" value="${f.fee}" aria-label="Valor (R$)"></td>
          <td><button type="button" class="link" data-rm="${i}">remover</button></td>
        </tr>`).join('');
      return;
    }

    const item = results.find(r => r.id === activeId);
    const cur = item ? measure(item).row : null;
    $('feeBody').innerHTML = FEES.map(f => `
      <tr class="${f === cur ? 'active' : ''}">
        <td>${f.max.toLocaleString('pt-BR')} km</td><td>${f.min} min</td><td>${fmtMoney(f.fee)}</td></tr>`).join('');
  }

  /** Histórico: mostra os valores calculados na época da consulta. */
  function renderHistory() {
    const ul = $('historyList');
    if (!history.length) { ul.innerHTML = '<li class="empty">Nenhuma consulta ainda.</li>'; return; }
    const motoboys = Store.load().motoboys;
    ul.innerHTML = history.map((h, i) => {
      const when = h.at ? new Date(h.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '';
      const who = motoboys.find(m => m.id === h.motoId)?.name;
      const dist = h.routeKm != null ? fmtKm(h.routeKm) : '—';
      const line = h.straight != null ? ` (reta ${fmtKm(h.straight)})` : '';
      return `<li><button type="button" data-i="${i}" title="${esc(h.display)}">
        <span class="h-addr">${esc(h.query)}
          <small>${dist}${line}${h.cep ? ' · CEP ' + esc(h.cep) : ''}${when ? ' · ' + when : ''}${who ? ' · ' + esc(who) : ''}</small></span>
        <span class="h-dist">${h.fee != null ? fmtMoney(h.fee) : '—'}</span></button></li>`;
    }).join('');
  }

  /* ---------------- HISTÓRICO (localStorage) ---------------- */

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; }
  }
  function saveHistory() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(history)); } catch { /* ignora */ }
  }
  /** Guarda CEP, endereço, distâncias, valor e data/hora (sem a geometria da rota). */
  function addHistory(item) {
    const m = measure(item);
    const rec = {
      query: item.query, display: item.display, lat: item.lat, lng: item.lng,
      hood: item.hood, city: item.city, cep: item.cep, approximate: item.approximate,
      routeKm: item.routeKm ?? null, straight: m.straight,
      fee: m.row ? m.row.fee : null,
      at: new Date().toISOString(), motoId: item.motoId || ''
    };
    history = [rec, ...history.filter(h => h.display !== item.display)].slice(0, 50);
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

  /** Aplica uma referência já com coordenadas e recalcula tudo. */
  async function applyReference(ref) {
    reference = { address: ref.address, lat: ref.lat, lng: ref.lng, ok: true };
    try { localStorage.setItem(REF_KEY, JSON.stringify({ address: ref.address, lat: ref.lat, lng: ref.lng })); } catch { /* ignora */ }
    drawRings();
    await Promise.all(results.map(fetchRoute));   // rotas antigas ficam inválidas
    renderAll(false);
    map.setView([reference.lat, reference.lng], 14);
  }

  /** Geocodifica (endereço ou CEP) e aplica como referência. */
  async function setReference(address, silent) {
    try {
      const found = await geocode(address);
      if (!found) throw new Error('não encontrado');
      await applyReference({ address, lat: parseFloat(found.hit.lat), lng: parseFloat(found.hit.lon) });
      if (found.approximate) showMessage('Referência localizada de forma aproximada (sem o número exato). Confira no mapa.', 'info');
      else if (!silent) showMessage('Endereço de referência atualizado.', 'info');
    } catch {
      if (!silent) { showMessage('Não foi possível localizar o novo endereço de referência. A anterior foi mantida.', 'error'); return; }
      reference = { address, lat: MAP_START.lat, lng: MAP_START.lng, ok: false };
      drawRings(); renderAll(false);
      showMessage('Não foi possível localizar o endereço de referência. Informe-o em "Alterar endereço de referência"; sem ele não há cálculo.', 'error');
    }
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

  /* ---- Edição da tabela do motoboy ---- */
  $('btnEditFees').addEventListener('click', () => {
    feesDraft = FEES.map(f => ({ ...f }));
    feesEditing = true; renderFees();
  });

  $('feePanel').addEventListener('input', (e) => {
    const c = e.target.closest('input.cell'); if (!c) return;
    feesDraft[+c.dataset.i][c.dataset.k] = parseFloat(c.value);
  });

  $('feePanel').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { feesDraft.splice(+rm.dataset.rm, 1); renderFees(); return; }

    if (e.target.closest('#btnFeeAdd')) {
      const last = feesDraft[feesDraft.length - 1];
      feesDraft.push({ max: last ? last.max + 0.5 : 0.5, min: last ? last.min : 10, fee: last ? last.fee : 0 });
      renderFees(); return;
    }
    if (e.target.closest('#btnFeeCancel')) { feesEditing = false; renderFees(); return; }

    if (e.target.closest('#btnFeeReset')) {
      if (!confirm('Restaurar a tabela padrão?')) return;
      feesDraft = DEFAULT_FEES.map(f => ({ ...f })); renderFees(); return;
    }

    if (e.target.closest('#btnFeeSave')) {
      const rows = feesDraft.map(f => ({ max: f.max, min: f.min, fee: f.fee }));
      const bad = rows.some(f => !(f.max > 0) || !(f.min >= 0) || !(f.fee >= 0));
      if (!rows.length || bad) { showMessage('Preencha raio, tempo e valor de todas as linhas com números válidos.', 'error'); return; }
      rows.sort((a, b) => a.max - b.max);
      if (rows.some((f, i) => i && f.max === rows[i - 1].max)) { showMessage('Há dois raios iguais na tabela.', 'error'); return; }
      FEES = rows;
      try { localStorage.setItem(FEES_KEY, JSON.stringify(FEES)); } catch { /* ignora */ }
      feesEditing = false;
      showMessage('Tabela do motoboy atualizada. O histórico mantém os valores da época.', 'info');
      renderAll(false);
    }
  });

  /* ---- Resultado: tentar a rota de novo / escolher motoboy ---- */
  const LEADER_PASS = 'admin'; // senha de líder para salvar uma entrega repetida

  /** Grava a entrega ativa (valor da rota real) no perfil do motoboy escolhido. */
  function doSave(item) {
    const motoId = $('selMoto').value;
    const { km, row } = measure(item);
    if (!motoId || !row) return;
    Store.addEntrega({
      motoboyId: motoId, address: item.display, km, fee: row.fee, min: row.min, at: new Date().toISOString()
    });
    const name = Store.load().motoboys.find(m => m.id === motoId)?.name || '';
    const box = $('overrideBox'); if (box) box.remove();
    showMessage(`Entrega salva no perfil de ${name}: ${fmtMoney(row.fee)} (${fmtKm(km)}).`, 'info');
  }

  $('resultBody').addEventListener('click', async (e) => {
    const item0 = results.find(r => r.id === activeId);

    if (item0 && e.target.closest('#btnSaveDelivery')) {
      if (!$('selMoto').value) { showMessage('Selecione o motoboy para salvar a entrega.', 'error'); return; }
      // Mesmo endereço, no mesmo dia, só pode ser salvo uma vez
      const today = Store.dayKey(new Date());
      const d = Store.load();
      const dup = d.entregas.find(x => x.address === item0.display && Store.dayKey(x.at) === today);
      if (!dup) { doSave(item0); return; }

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

    if (item0 && e.target.closest('#btnOverride')) {
      if ($('leaderPass').value === LEADER_PASS) doSave(item0);
      else showMessage('Senha de líder incorreta.', 'error');
      return;
    }

    if (!e.target.closest('#btnRetryRoute')) return;
    const item = item0;
    if (!item) return;
    e.target.disabled = true; e.target.textContent = 'Calculando…';
    await fetchRoute(item);
    if (item.routeKm != null) { addHistory(item); clearMessage(); }
    else showMessage('Ainda não foi possível calcular a rota. Tente novamente em instantes.', 'error');
    renderAll(false);
  });

  $('resultBody').addEventListener('change', (e) => {
    if (e.target.id !== 'selMoto') return;
    const item = results.find(r => r.id === activeId);
    if (!item) return;
    item.motoId = e.target.value;
    Store.setLast(item.motoId);
    const rec = history.find(h => h.display === item.display);
    if (rec) { rec.motoId = item.motoId; saveHistory(); }
    renderHistory();
  });

  $('btnLogout').addEventListener('click', () => {
    try { sessionStorage.removeItem('raio-barueri-sessao'); } catch { /* ignora */ }
    location.replace('login.html');
  });

  $('btnClearHistory').addEventListener('click', () => {
    history = []; saveHistory(); renderHistory();
  });

  /** Consultar de novo um endereço do histórico: refaz a rota e mostra o valor anterior. */
  $('historyList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-i]');
    if (!btn) return;
    const h = history[+btn.dataset.i];
    if (!reference.ok) { showMessage('O endereço de referência não foi localizado.', 'error'); return; }
    const item = {
      id: Date.now(), query: h.query, display: h.display, lat: h.lat, lng: h.lng,
      hood: h.hood, city: h.city, cep: h.cep, approximate: h.approximate, motoId: h.motoId || '',
      prev: h.fee != null ? { fee: h.fee, routeKm: h.routeKm, at: h.at } : null
    };
    await fetchRoute(item);
    results = results.filter(r => r.display !== h.display);
    results.push(item);
    activeId = item.id;
    input.value = h.query;
    clearMessage();
    renderAll(true);
    if (item.routeKm == null) showMessage('Não foi possível calcular a rota agora. Tente novamente.', 'error');
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

  // Referência salva (com coordenadas): usada direto, sem depender da rede
  let saved = null, raw = null;
  try { raw = localStorage.getItem(REF_KEY); saved = JSON.parse(raw); } catch { /* formato antigo ou vazio */ }
  if (saved && saved.address && isFinite(saved.lat) && isFinite(saved.lng)) {
    applyReference(saved);
  } else {
    setReference((raw && !saved ? raw : null) || DEFAULT_REFERENCE, true);
  }
})();
