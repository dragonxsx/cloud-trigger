const root = document.documentElement;
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

const currentTheme = () => root.dataset['theme'] ?? (darkQuery.matches ? 'dark' : 'light');

document.getElementById('theme-toggle')?.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  root.dataset['theme'] = next;
  try {
    localStorage.setItem('ct-theme', next);
  } catch {}
});

const htmlElements = (selector, scope = document) =>
  [...scope.querySelectorAll(selector)].filter((el) => el instanceof HTMLElement);

for (const button of htmlElements('[data-copy]')) {
  const label = button.textContent;
  const flash = (text = '') => {
    button.textContent = text;
    setTimeout(() => {
      button.textContent = label;
    }, 1600);
  };
  button.addEventListener('click', () => {
    navigator.clipboard.writeText(button.dataset['copy'] ?? '').then(
      () => flash('Copied'),
      () => flash('Press Ctrl+C'),
    );
  });
}

for (const tabs of htmlElements('[data-tabs]')) {
  const buttons = htmlElements('[role="tab"]', tabs);
  const select = (target) => {
    for (const button of buttons) {
      const selected = button === target;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(button.getAttribute('aria-controls') ?? '');
      if (panel) {
        panel.hidden = !selected;
      }
    }
  };
  for (const button of buttons) {
    button.addEventListener('click', () => select(button));
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
        return;
      }
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const next = buttons[(buttons.indexOf(button) + step + buttons.length) % buttons.length];
      if (next) {
        select(next);
        next.focus();
      }
    });
  }
}
