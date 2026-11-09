import { Database, FileText, LayoutTemplate, Settings, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/datasets', label: 'Datasets', icon: Database },
  { to: '/reports', label: 'Reports', icon: FileText },
  { to: '/templates', label: 'Templates', icon: LayoutTemplate },
  { to: '/settings', label: 'Settings', icon: Settings },
];
