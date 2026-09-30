import { NavLink, Outlet, useMatch } from 'react-router-dom'
import { cn } from '@/lib/utils'

function NavItem({ to, label }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) => cn(
        'rounded-lg px-3.5 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground',
        isActive && 'bg-secondary font-medium text-foreground',
      )}
    >
      {label}
    </NavLink>
  )
}

export function Wordmark() {
  return (
    <span className="text-base font-bold tracking-tight">
      vlog<span className="text-primary">smith</span>
    </span>
  )
}

// A job page brings its own header (back link, tabs, stepper) and fills the window,
// so the app bar only shows on the list and settings pages.
export default function Layout() {
  const onJob = useMatch('/jobs/:jobId')
  if (onJob) return <Outlet />

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-6 border-b bg-paper px-10">
        <Wordmark />
        <nav className="ml-auto flex gap-1">
          <NavItem to="/" label="任务" />
          <NavItem to="/settings" label="设置" />
        </nav>
      </header>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  )
}
