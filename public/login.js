const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.textContent = '';
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  const response = await fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    errorBox.textContent = 'Неверный логин или пароль';
    return;
  }
  window.location.href = '/';
});
