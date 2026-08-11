# MaiinSight Backend

Express.js REST API for MaiinSight, a customer segmentation and marketing insight system for Maiin Gandaria.

**Repository:** https://github.com/tibatibacapstone/maiinsight-backend

## Tech Stack

- Node.js 20.x
- Express.js 4.22
- MySQL 8.0 via Prisma 5.22
- Gemini API (AI strategy generation)
- Meta Graph API v25.0 (Instagram analytics)
- `helmet`, `cors`, `morgan` for common API middleware
- `nodemon` for local development

## Getting Started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Make sure Docker MySQL is running:

   ```bash
   docker compose up -d
   ```

3. Run database migration and seed:

   ```bash
   npx prisma migrate dev
   npm run seed
   ```

4. Start the development server:

   ```bash
   npm run dev
   ```

The API runs on `http://localhost:5000` by default.

## Environment Variables

Copy `.env.example` to `.env` and configure (see [Installation Guide](../docs/INSTALLATION-GUIDE.md)).

`JWT_SECRET` is required and must be a strong, randomly generated secret shared by all
backend instances. The API intentionally fails during startup when it is missing. Never
commit the production secret or generate a different value on each restart.

`GOOGLE_CLIENT_ID` must be the MaiinSight Google OAuth web client ID and must match
the frontend `NEXT_PUBLIC_GOOGLE_CLIENT_ID`. Google login accepts only signed Google
ID tokens whose audience is this configured client.

Service tokens issued by IT Support are separate from user access tokens. They are
limited to the `system:read-status` scope and may call `GET /api/system/status`
only. The creator must still exist, remain active, and retain the IT Support role.
Legacy `type: "service_token"` tokens receive the same narrow compatibility scope;
regenerate them to receive explicit service IDs and scope claims.

## Available Scripts

```bash
npm run dev           # Start dev server with nodemon
npm start             # Start production server
npm run lint          # Run ESLint
npm test              # Run tests
npm run seed          # Seed users without resetting existing passwords
npx prisma migrate dev   # Run Prisma migration
npx prisma studio        # Open Prisma Studio (DB viewer)
```

## Project Structure

```text
src/
  app.js
  server.js
  config/
    database.js
    env.js
    prisma.js
  middleware/
    auth.js
    error-handler.js
    not-found.js
  routes/
    auth.routes.js
    health.routes.js
    dashboard.routes.js
    aiStrategyRoute.js
    importRoutes.js
    meta.routes.js
    segmentation.routes.js
    targeting.routes.js
    operations.routes.js
    system.routes.js
    index.js
  services/
    rfmSegmentation.service.js
    importFile.service.js
    ...
```

## Seeded Accounts

The seed creates the Operational, Management, and IT Support accounts when they are
missing. Configure `SEED_MARKETING_OPERATIONAL_PASSWORD`, `SEED_MANAGEMENT_PASSWORD`,
and `SEED_IT_SUPPORT_PASSWORD` with strong, unique values before creating them. There
are no development or production fallback passwords. Known defaults and placeholders
are rejected. Re-running the seed may normalize seeded names and roles, but it never
changes an existing user's password.
