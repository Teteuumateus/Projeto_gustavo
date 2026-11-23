/* Tela de motoboys: perfis, entregas do dia e ganhos. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const money = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const km2 = (v) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let selected = null;                 // id do motoboy selecionado
  $('dayInput').value = Store.dayKey(new Date());

  function render() {
    const data = Store.load();
    if (!data.motoboys.some(m => m.id === selected)) {
      selected = data.lastMoto && data.motoboys.some(m => m.id === data.lastMoto)
        ? data.lastMoto : (data.motoboys[0]?.id || null);
    }

    // Lista de perfis (com total de hoje)
    const today = Store.dayKey(new Date());
    $('motoList').innerHTML = data.motoboys.length ? data.motoboys.map(m => {
      const total = data.entregas.filter(e => e.motoboyId === m.id && Store.dayKey(e.at) === today)
        .reduce((s, e) => s + e.fee, 0);
      return `<li><button type="button" data-id="${m.id}" class="${m.id === selected ? 'sel' : ''}">
        <span class="h-addr">${esc(m.name)}</span><span class="h-dist">${money(total)} hoje</span></button></li>`;
    }).join('') : '<li class="empty">Nenhum motoboy cadastrado.</li>';

    const m = data.motoboys.find(x => x.id === selected);
    $('motoEmpty').hidden = !!m;
    $('motoDetail').hidden = !m;
    if (!m) return;

    $('motoTitle').textContent = m.name;
    $('motoPhoneLabel').textContent = m.phone ? '📞 ' + m.phone : '';

    const mine = data.entregas.filter(e => e.motoboyId === m.id);
    const day = $('dayInput').value || today;
    const dayList = mine.filter(e => Store.dayKey(e.at) === day).sort((a, b) => a.at.localeCompare(b.at));

    $('statTotal').textContent = money(dayList.reduce((s, e) => s + e.fee, 0));
    $('statCount').textContent = dayList.length;
    $('statKm').textContent = km2(dayList.reduce((s, e) => s + e.km, 0));

    $('dayBody').innerHTML = dayList.length ? dayList.map(e => `
      <tr><td>${new Date(e.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</td>
        <td class="addr">${esc(e.address)}</td><td>${km2(e.km)}</td><td>${money(e.fee)}</td>
        <td><button class="link" data-del="${e.id}" type="button">remover</button></td></tr>`).join('')
      : '<tr><td colspan="5" class="empty">Nenhuma entrega neste dia.</td></tr>';

    // Resumo por dia (mais recente primeiro)
    const byDay = {};
    mine.forEach(e => { const k = Store.dayKey(e.at); (byDay[k] ||= []).push(e); });
    const days = Object.keys(byDay).sort().reverse();
    $('summaryBody').innerHTML = days.length ? days.map(k => {
      const [y, mo, d] = k.split('-');
      return `<tr class="${k === day ? 'active' : ''}"><td><button class="link day" data-day="${k}" type="button">${d}/${mo}/${y}</button></td>
        <td>${byDay[k].length}</td><td>${money(byDay[k].reduce((s, e) => s + e.fee, 0))}</td></tr>`;
    }).join('') : '<tr><td colspan="3" class="empty">Sem entregas registradas.</td></tr>';
  }

  $('motoForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('motoName').value.trim();
    if (!name) return;
    selected = Store.addMoto(name, $('motoPhone').value.trim()).id;
    e.target.reset(); render();
  });

  $('motoList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]'); if (!b) return;
    selected = b.dataset.id; render();
  });

  $('dayInput').addEventListener('change', render);

  document.body.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del && confirm('Remover esta entrega?')) { Store.removeEntrega(del.dataset.del); render(); }
    const day = e.target.closest('[data-day]');
    if (day) { $('dayInput').value = day.dataset.day; render(); }
  });

  $('btnRemoveMoto').addEventListener('click', () => {
    if (confirm('Excluir este motoboy e todas as entregas dele?')) { Store.removeMoto(selected); render(); }
  });

  $('btnLogout').addEventListener('click', () => {
    try { sessionStorage.removeItem('raio-barueri-sessao'); } catch { /* ignora */ }
    location.replace('login.html');
  });

  render();
})();
