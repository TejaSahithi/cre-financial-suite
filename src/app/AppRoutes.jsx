import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { pagesConfig } from '@/pages.config';
import PageNotFound from '@/lib/PageNotFound';
import RbacGuard from '@/features/access-control/RbacGuard';
import LayoutWrapper from './LayoutWrapper';

const { Pages, mainPage } = pagesConfig;
const mainPageKey = mainPage ?? Object.keys(Pages)[0];
const MainPage = mainPageKey ? Pages[mainPageKey] : <></>;

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={
        <LayoutWrapper currentPageName={mainPageKey}>
          <MainPage />
        </LayoutWrapper>
      } />
      <Route path="/signin" element={<Navigate to="/Login" replace />} />
      {Object.entries(Pages).map(([path, Page]) => {
        const isMandatorySetup = ["Onboarding", "Welcome", "WelcomeAboard", "PaymentSuccess"].includes(path);
        return (
          <Route
            key={path}
            path={`/${path}`}
            element={
              <RbacGuard pageName={path}>
                {isMandatorySetup ? (
                  <Page />
                ) : (
                  <LayoutWrapper currentPageName={path}>
                    <Page />
                  </LayoutWrapper>
                )}
              </RbacGuard>
            }
          />
        );
      })}
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
}
