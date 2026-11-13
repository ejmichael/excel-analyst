import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { Check, ChevronsUpDown, LogOut, Menu, Palette, Settings, UserRound } from 'lucide-react';
import { useSession } from '@/auth/SessionProvider';
import { useMe } from '@/auth/useMe';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { env } from '@/env';
import { PLAN_LABELS } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { WorkspaceProvider, useActiveWorkspace } from '@/features/workspaces/WorkspaceProvider';
import { ReportTray } from '@/features/reports/ReportTray';
import { useReportTray } from '@/features/reports/tray';
import { BrandMark } from './BrandMark';
import { NAV_ITEMS } from './nav';

export function AppShell() {
  return (
    <WorkspaceProvider>
      <ShellLayout />
    </WorkspaceProvider>
  );
}

function ShellLayout() {
  const { active } = useActiveWorkspace();
  const trayOpen = useReportTray(active?.id).items.length > 0;
  return (
    <>
      <div className="min-h-dvh bg-background md:grid md:grid-cols-[15rem_1fr]">
        <aside className="hidden border-r bg-card md:flex md:min-h-dvh md:flex-col">
          <div className="px-5 py-5">
            <Wordmark />
          </div>
          <SidebarNav />
        </aside>
        <div className="flex min-w-0 flex-col">
          <TopBar />
          {/* Room for the report tray: a bar at the bottom on small screens, a side panel on wide ones. */}
          <main id="main" className={cn('flex-1 px-4 py-6 sm:px-8', trayOpen && 'pb-28 lg:pr-[22rem] lg:pb-6')}>
            <Outlet />
          </main>
        </div>
      </div>
      <ReportTray workspaceId={active?.id} />
    </>
  );
}

function Wordmark() {
  return (
    <Link to="/datasets" className="inline-flex min-h-11 items-center gap-2 rounded-md font-heading text-lg font-semibold">
      <BrandMark />
      {env.appName}
    </Link>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="px-3">
      <ul className="space-y-1">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <li key={to}>
            <NavLink
              to={to}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground',
                  isActive && 'bg-accent text-foreground',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon className={cn('size-4', isActive && 'text-primary')} aria-hidden />
                  <span>{label}</span>
                  {isActive && <span className="sr-only">(current page)</span>}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function MobileNav() {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open the menu">
          <Menu className="size-5" aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 bg-card p-0">
        <SheetHeader className="px-5 pt-5">
          <SheetTitle asChild>
            <div>
              <Wordmark />
            </div>
          </SheetTitle>
          <SheetDescription className="sr-only">Main navigation</SheetDescription>
        </SheetHeader>
        <SidebarNav onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

function TopBar() {
  const me = useMe();
  return (
    <header className="sticky top-0 z-30 flex min-h-16 items-center gap-2 border-b bg-background/95 px-2 sm:px-6">
      <MobileNav />
      <WorkspaceSwitcher />
      <div className="ml-auto flex items-center gap-1 sm:gap-3">
        {me.data && (
          <Badge variant="outline" className="h-7 rounded-full border-primary/40 bg-accent px-2.5 text-xs font-medium">
            <span className="sr-only">Current plan: </span>
            {PLAN_LABELS[me.data.plan]}
            <span className="hidden sm:inline">plan</span>
          </Badge>
        )}
        <UserMenu />
      </div>
    </header>
  );
}

function WorkspaceSwitcher() {
  const { workspaces, active, setActiveId, isLoading } = useActiveWorkspace();
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="min-w-0 max-w-[13rem] justify-between gap-2 bg-card sm:max-w-xs">
          <span className="flex min-w-0 flex-col items-start leading-tight">
            <span className="text-[11px] font-normal text-muted-foreground">Workspace</span>
            <span className="max-w-full truncate">{isLoading ? 'Loading…' : (active?.name ?? 'None')}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
        {workspaces.map((w) => (
          <DropdownMenuItem key={w.id} onSelect={() => setActiveId(w.id)}>
            <Check className={cn('size-4', w.id === active?.id ? 'opacity-100' : 'opacity-0')} aria-hidden />
            <span className="truncate">{w.name}</span>
            {w.is_default && <span className="ml-auto text-xs text-muted-foreground">Default</span>}
            {w.id === active?.id && <span className="sr-only">(selected)</span>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/settings#workspaces')}>
          <Settings className="size-4" aria-hidden />
          Manage workspaces
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu() {
  const me = useMe();
  const { signOut, session } = useSession();
  const navigate = useNavigate();
  const email = me.data?.email ?? session?.email ?? '';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Your account">
          <UserRound className="size-5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <span className="block font-medium">{me.data?.full_name || 'Signed in as'}</span>
          <span className="block truncate text-muted-foreground">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/settings')}>
          <Settings className="size-4" aria-hidden />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/settings/brand')}>
          <Palette className="size-4" aria-hidden />
          Your brand
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void signOut().then(() => navigate('/sign-in', { replace: true }))}>
          <LogOut className="size-4" aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
