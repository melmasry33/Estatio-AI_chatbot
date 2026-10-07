import { redirect } from 'next/navigation'

// Backend-only deployment: the real UI lives in your own frontend.
// Set FRONTEND_URL to redirect visitors there; otherwise show a plain status line.
export default function Home() {
  const frontend = process.env.FRONTEND_URL
  if (frontend) redirect(frontend)
  return <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>Estatio API is running.</main>
}
