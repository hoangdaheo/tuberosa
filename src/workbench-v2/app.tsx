import { render } from 'preact';
function App() { return <main><h1>Tuberosa Workbench v2</h1></main>; }
const root = document.getElementById('app');
if (root) render(<App />, root);
