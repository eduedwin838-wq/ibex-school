# Ibex Student System

## Project Map

- The active application is the Express server in [backend/server.js](backend/server.js).
- EJS templates are in [frontend/views](frontend/views), and the active static directory is [frontend/public](frontend/public).
- The database schema is [backend/student.sql](backend/student.sql).
- `backend/src/controllers`, `backend/src/models`, `backend/src/routes`, and `backend/src.config` are currently empty; do not assume they are wired into the server.
- [frontend/public/main.js](frontend/public/main.js) is an older, inactive server implementation despite its location under the static directory. Do not treat it as browser code or the active backend.

## Development Commands

Run backend commands from `backend/`:

```text
npm start       # start the active server on port 3000
npm run dev     # start the server with nodemon
```

The root Vite scripts (`npm run dev`, `npm run build`, `npm run preview`) are currently not a reliable application workflow because the repository has no root `index.html` or Vite entrypoint. There are no automated tests, lint scripts, or formatter configuration. At minimum, validate backend changes by starting the server and exercising the affected HTTP route when MySQL is available.

## Backend Conventions

- The server uses CommonJS, Express, EJS, and callback-style `mysql2` queries.
- The server renders views from `frontend/views` and serves assets from `frontend/public`.
- Existing authentication is placeholder-only (`dummyUser`); `express-session` and bcrypt are installed but unused by the active entrypoint. Do not describe a route as protected unless middleware is actually added.
- Keep database access and route behavior consistent with the active entrypoint unless a refactor is explicitly requested.
- Do not add new hardcoded database credentials or session secrets. Prefer environment variables when changing configuration, while preserving the current local setup unless the task includes migration.

## Database Contract

- MySQL must be running locally, and the `students_db` database must exist before database-backed routes can work. [backend/student.sql](backend/student.sql) selects the database but does not create it.
- The current schema uses camelCase student columns: `admissionNo` and `parentContact`.
- Several active templates still read legacy snake_case names (`admission_no`, `parent_phone`). Check the schema, server query, request field names, and EJS property names together when changing student data.
- Do not silently swallow database errors in new routes. Return an appropriate response and preserve enough logging to diagnose local setup failures.

## Views and Routes

- Shared partials exist at `frontend/views/_header.ejs` and `frontend/views/_footer.ejs`, but existing views are not consistently composed from them; follow the surrounding file unless consolidating views is part of the task.
- Active routes include `/`, `/dashboard`, `/students`, `/students/add`, `/add_student`, and `GET /students/edit/:id`.
- Links for login, logout, delete, and edit submission are present in views but are not fully implemented by the active server. Verify both GET and POST behavior before claiming those workflows work.

## Change Checklist

1. Confirm the change belongs to `backend/server.js` and `frontend/views`, rather than the inactive duplicate server.
2. Check database column names against [backend/student.sql](backend/student.sql).
3. Start the backend with `cd backend && npm start` and exercise the changed route when MySQL is available.
4. Report environmental blockers such as a missing MySQL service or database separately from code failures.
