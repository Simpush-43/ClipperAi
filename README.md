# ClipperAi

## Render deployment

The repository is already split into `frontend/` and `backend/`. Deploy it as one Render web service from the repository root; `render.yaml` builds the frontend into `frontend/dist` and the backend serves it alongside the API.

In Render, create a Blueprint from this repository and set the prompted environment variables. `DASHBOARD_PASSWORD` must be at least 12 characters, and `DASHBOARD_SESSION_SECRET` must be at least 32 characters. MongoDB, Cloudflare R2, Groq, and Gemini credentials are required for the app's storage and clip-generation workflows. Instagram credentials are only needed for Instagram publishing.
