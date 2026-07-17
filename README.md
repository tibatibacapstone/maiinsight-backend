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

## Available Scripts

```bash
npm run dev           # Start dev server with nodemon
npm start             # Start production server
npm run lint          # Run ESLint
npm test              # Run tests
npm run seed          # Seed database with default users
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

## Default Test Accounts

| Email                       | Password       | Role         |
|-----------------------------|----------------|--------------|
| `operational@maiin.com`     | `Password123!` | Operational  |
| `management@maiin.com`      | `Password123!` | Management  |
| `support@maiin.com`         | `Password123!` | IT Support  |
