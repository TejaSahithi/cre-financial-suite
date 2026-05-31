import React from 'react';
import { pagesConfig } from '@/pages.config';

const { Layout } = pagesConfig;

export default function LayoutWrapper({ children, currentPageName }) {
  if (Layout) {
    return <Layout currentPageName={currentPageName}>{children}</Layout>;
  }
  return <>{children}</>;
}
