# Security Monitor frontend

This independent, no-build frontend is served by `server.js` and calls the monitor API on port 5005. It uses only Node.js built-ins; do not run `npm install`.

## Run

From `security-monitor/frontend`:

```
Copy-Item .env.example .env
npm run dev
```

Open `http://localhost:5174`. The backend must be running at `http://localhost:5005`, and its `FRONTEND_ORIGIN` must be `http://localhost:5174` for credentialed API requests. Use `localhost` for both URLs because the admin session cookie is `SameSite=Strict`.

## Verify

```
npm test
```

The HTML, CSS, and JavaScript live in `public/`; there is no bundler or generated build directory.
