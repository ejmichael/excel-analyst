import { Navigate, Outlet, createBrowserRouter, type RouteObject } from 'react-router';
import { ApiEventBridge } from '@/auth/ApiEventBridge';
import { PublicOnly, RequireApp, RequireConsentPending } from '@/auth/guards';
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage';
import { SignInPage } from '@/features/auth/SignInPage';
import { SignUpPage } from '@/features/auth/SignUpPage';
import { ConsentPage } from '@/features/consent/ConsentPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { AppShell } from '@/features/shell/AppShell';
import { LegalPlaceholderPage, NotFoundPage, PlaceholderPage } from '@/features/shell/pages';

function Root() {
  return (
    <>
      <ApiEventBridge />
      <Outlet />
    </>
  );
}

export const routes: RouteObject[] = [
  {
    element: <Root />,
    children: [
      {
        element: <PublicOnly />,
        children: [
          { path: '/sign-in', element: <SignInPage /> },
          { path: '/sign-up', element: <SignUpPage /> },
          { path: '/forgot-password', element: <ForgotPasswordPage /> },
        ],
      },
      // Reached from the recovery email with a one-time session, so it is not signed-out only.
      { path: '/reset-password', element: <ResetPasswordPage /> },
      { path: '/terms', element: <LegalPlaceholderPage kind="terms" /> },
      { path: '/privacy', element: <LegalPlaceholderPage kind="privacy" /> },
      {
        element: <RequireConsentPending />,
        children: [{ path: '/consent', element: <ConsentPage /> }],
      },
      {
        element: <RequireApp />,
        children: [
          {
            element: <AppShell />,
            children: [
              { path: '/', element: <Navigate to="/datasets" replace /> },
              { path: '/datasets', element: <PlaceholderPage title="Datasets" /> },
              { path: '/reports', element: <PlaceholderPage title="Reports" /> },
              { path: '/templates', element: <PlaceholderPage title="Templates" /> },
              { path: '/settings', element: <SettingsPage /> },
            ],
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const createAppRouter = () => createBrowserRouter(routes);
