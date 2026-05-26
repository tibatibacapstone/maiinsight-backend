# MaiinSight Backend

Express.js API for MaiinSight, a customer segmentation and marketing insight system for Maiin Gandaria.

## Tech Stack

- Node.js 20+
- Express.js
- PostgreSQL via `pg`
- Gemini API client via `@google/generative-ai`
- `helmet`, `cors`, and `morgan` for common API middleware
- `nodemon` for local development

## Getting Started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a local environment file:

   ```bash
   cp .env.example .env
   ```

3. Update `.env` with your local PostgreSQL, Gemini, and Meta credentials.

4. Start the development server:

   ```bash
   npm run dev
   ```

The API runs on `http://localhost:5000` by default.

## Available Endpoints

- `GET /api` - API metadata
- `GET /api/health` - service health check
- `GET /api/health/database` - PostgreSQL connectivity check

## Project Structure

```text
src/
  app.js
  server.js
  config/
    database.js
    env.js
  middleware/
    error-handler.js
    not-found.js
  routes/
    health.routes.js
    index.js
```
