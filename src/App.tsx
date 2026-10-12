import { useEffect } from 'react';
import { Home } from './components/Home.tsx';
import { Editor } from './components/Editor.tsx';
import { PlanPage } from './components/PlanPage.tsx';
import { Toasts } from './components/Toasts.tsx';
import { projectIdFrom, usePath } from './router.ts';
import { loadFonts } from './engine/fonts.ts';

export function App() {
  const path = usePath();
  const projectId = projectIdFrom(path);
  useEffect(() => loadFonts(), []);
  return (
    <>
      {projectId ? <Editor key={projectId} projectId={projectId} /> : path === '/plan' ? <PlanPage /> : <Home />}
      <Toasts />
    </>
  );
}
