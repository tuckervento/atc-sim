const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('index.html is missing the #app element');
}

const heading = document.createElement('h1');
heading.textContent = 'ATC Ground — scaffold';
app.replaceChildren(heading);
