# CRE Financial Suite

Professional Commercial Real Estate Financial Analysis and Management Platform.

## Features
- **Portfolio Management**: Holistic view of your CRE properties.
- **Lease Administration**: Automated expiry alerts and status tracking.
- **Budgeting & CAM**: Generate budgets from leases and track expense variances.
- **Intelligent Reporting**: Drill-down insights into property performance.
- **Secure Auth**: Multi-tenant isolation with Supabase.

## Prerequisites
1. Clone the repository.
2. Install dependencies: `npm install`
3. Set up environment variables in `.env.local`:
   ```bash
   VITE_SUPABASE_URL=your_supabase_url
   VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
   ```

## Development
Run the app locally:
```bash
npm run dev
```

## Tech Stack
- **Frontend**: React, Vite, Tailwind CSS, Shadcn UI
- **Backend**: Supabase (Auth, Database, Edge Functions)
- **Charts**: Recharts
- **Icons**: Lucide React
