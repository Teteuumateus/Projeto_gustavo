/* Tela de login (validação no navegador). Usuário: admin · Senha: admin */
(function () {
  'use strict';
  const USER = 'admin', PASS = 'admin';
  const KEY = 'raio-barueri-sessao';

  // Já logado? Vai direto para o sistema.
  try { if (sessionStorage.getItem(KEY) === '1') { location.replace('index.html'); return; } } catch { /* ignora */ }

  document.getElementById('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const ok = document.getElementById('user').value.trim() === USER &&
               document.getElementById('pass').value === PASS;
    if (!ok) { document.getElementById('loginError').hidden = false; return; }
    try { sessionStorage.setItem(KEY, '1'); } catch { /* ignora */ }
    location.replace('index.html');
  });
})();
