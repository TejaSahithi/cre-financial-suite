import React, { Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { pagesConfig } from '@/pages.config';
import PageNotFound from '@/lib/PageNotFound';
import RbacGuard from '@/features/access-control/RbacGuard';
import { MANDATORY_SETUP_PAGES } from '@/lib/rbac';
import LayoutWrapper from './LayoutWrapper';
import LoadingScreen from './LoadingScreen';

const { Pages, mainPage } = pagesConfig;
const mainPageKey = mainPage ?? Object.keys(Pages)[0];
const MainPage = mainPageKey ? Pages[mainPageKey] : <></>;

function RouteSuspense({ children }) {
  return (
    <Suspense fallback={<LoadingScreen />}>
      {children}
    </Suspense>
  );
}

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={
        <RouteSuspense>
          <LayoutWrapper currentPageName={mainPageKey}>
            <MainPage />
          </LayoutWrapper>
        </RouteSuspense>
      } />
      <Route path="/signin" element={<Navigate to="/Login" replace />} />
      {Object.entries(Pages).map(([path, Page]) => {
        const isMandatorySetup = MANDATORY_SETUP_PAGES.includes(path);
        return (
          <Route
            key={path}
            path={`/${path}`}
            element={
              <RouteSuspense>
                <RbacGuard pageName={path}>
                  {isMandatorySetup ? (
                    <Page />
                  ) : (
                    <LayoutWrapper currentPageName={path}>
                      <Page />
                    </LayoutWrapper>
                  )}
                </RbacGuard>
              </RouteSuspense>
            }
          />
        );
      })}
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
}
